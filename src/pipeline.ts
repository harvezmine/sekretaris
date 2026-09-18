import { config } from "./config.js";
import { getUser, sql, updateUser, type UserRow } from "./db/index.js";
import type { Agent } from "./agent/run.js";
import { closeSessions, recordStaticExchange } from "./agent/session.js";
import { quotaState } from "./agent/tools.js";
import { deleteUserMedia, discardInboundMedia, loadInboundMedia, saveMediaCapture, saveTextCapture } from "./capture/ingest.js";
import { findCode, hasPendiriRedemption, looksLikeCode, redeem } from "./onboarding/codes.js";
import * as copy from "./onboarding/copy.js";
import {
  CONNECT_ROWS,
  FINISH,
  helpFor,
  isSetupStep,
  isYes,
  keywordAction,
  looksLikeRequest,
  nextStep,
  parseConnectChoice,
  QUICK_ACTIONS,
  QUICK_MENU_LABEL,
  quickRows,
  SKIP,
  withConnectStep,
  type ConnectChoice,
  type QuickAction,
  type SetupStep,
} from "./onboarding/setup.js";
import { preboardReply } from "./onboarding/preboard.js";
import {
  actionButtons,
  cancelAction,
  claimAction,
  finishAction,
  getAction,
  lastActionId,
  pendingActionAfter,
  type PendingAction,
} from "./actions/pending.js";
import { actionPreview, actionQuestion, runAction } from "./google/actions.js";
import {
  disconnect as disconnectGoogle,
  enabledServices,
  getAccount,
  googleEnabled,
  SERVICE_LABEL,
  servicesGranted,
  type AuthResult,
  type GoogleService,
} from "./google/client.js";
import { CONNECT_MINUTES, connectUrlFor } from "./google/connect.js";
import { serverToolsFor } from "./servers/registry.js";
import { listUserServers } from "./servers/userServers.js";
import { DEFAULT_ASSISTANT_NAME, findPersona, personaMenu } from "./persona/catalog.js";
import { agendaText } from "./profile/agenda.js";
import { normalizeCallName, normalizeWork, profileSummary, updateProfile } from "./profile/profile.js";
import {
  activeThreadFor,
  assistantLabel,
  cancelRelay,
  composeRelayText,
  CONFIRM_MINUTES,
  confirmRelay,
  messageSendFor,
  ownerLabel,
  lastRelayId,
  pendingDraftAfter,
  recordRelayReply,
  relayButtons,
  takeUnseenReplies,
  type RelayRow,
} from "./relay/service.js";
import { uploadUrlFor } from "./uploads/links.js";
import { hasAccess, type Payments } from "./payments/service.js";
import { sttEnabled, transcribe } from "./voice/transcribe.js";
import type { WhatsApp } from "./wa/client.js";
import type { Inbound, SharedContact } from "./wa/inbound.js";
import type { Outbox } from "./wa/outbox.js";
import { addDays, errorMessage, formatDate, formatDateTime, normalizePhone, type Logger } from "./util.js";

export interface PipelineDeps {
  wa: WhatsApp;
  outbox: Outbox;
  payments: Payments;
  agent: Agent;
  log: Logger;
}

export type State =
  | "NEW"
  | "MENU"
  | "AWAITING_CODE"
  | "AWAITING_PAYMENT"
  | "PREBOARD"
  | "SETUP"
  | "READY"
  | "CONFIRM_DELETE"
  | "OPTED_OUT";

interface PendingMessage {
  id: string;
  wamid: string;
  inbound: Inbound;
}

const KEYWORDS = ["STOP", "HAPUS", "MULAI", "MENU"] as const;

/** A first message that is only a hello needs no answer beyond the hello back. */
const GREETING = /^(halo+|hallo+|hai+|hi+|hey|helo+|p|ping|tes|test|assalam[^]*|pagi|siang|sore|malam|selamat \w+)[\s!.?]*$/i;
type Keyword = (typeof KEYWORDS)[number];

async function takePending(userId: string): Promise<PendingMessage[]> {
  const rows = await sql<{ id: string; wamid: string; payload: Inbound }[]>`
    update messages set processed = true
    where id in (
      select id from messages
      where user_id = ${userId} and direction = 'in' and processed = false
      order by id
      for update skip locked
    )
    returning id, wamid, payload
  `;
  return rows
    .map((r) => ({ id: r.id, wamid: r.wamid, inbound: r.payload }))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

function findKeyword(batch: PendingMessage[]): Keyword | undefined {
  const words = new Set(
    batch.filter((m) => m.inbound.kind === "text").map((m) => (m.inbound as { text: string }).text.trim().toUpperCase()),
  );
  return KEYWORDS.find((k) => words.has(k));
}

function lastOf<K extends Inbound["kind"]>(batch: PendingMessage[], kind: K): Extract<Inbound, { kind: K }> | undefined {
  for (let i = batch.length - 1; i >= 0; i--) {
    const inbound = batch[i]!.inbound;
    if (inbound.kind === kind) return inbound as Extract<Inbound, { kind: K }>;
  }
  return undefined;
}

export class Pipeline {
  constructor(private readonly d: PipelineDeps) {}

  async process(userId: string): Promise<void> {
    const user = await getUser(userId);
    if (!user) return;
    const batch = await takePending(userId);
    if (!batch.length) return;

    try {
      await this.route(user, batch);
    } catch (err) {
      this.d.log.error({ err, userId }, "gagal memproses pesan");
      if (user.state !== "OPTED_OUT") {
        await this.d.outbox.text(user, copy.TEXT.failure, { raw: true }).catch(() => {});
      }
    }
  }

  private async route(user: UserRow, batch: PendingMessage[]): Promise<void> {
    const keyword = findKeyword(batch);

    if (user.state === "OPTED_OUT") {
      if (keyword === "MULAI") await this.resume(user);
      return;
    }
    switch (keyword) {
      case "STOP":
        return this.optOut(user);
      case "HAPUS":
        return this.confirmDelete(user);
      case "MULAI":
      case "MENU":
        return this.showMenu(user);
    }

    if (!user.plan && !user.consentAt && (user.state === "NEW" || user.state === "MENU")) {
      const thread = await activeThreadFor(user.waId);
      if (thread) return this.forwardRelayReply(user, thread, batch);
    }

    const button = lastOf(batch, "button");
    if (button) {
      await this.handleButton(user, button.id);
      const rest = batch.filter((m) => m.inbound.kind !== "button");
      const fresh = rest.length ? await getUser(user.id) : undefined;
      if (fresh?.state === "READY") await this.handleReady(fresh, rest);
      return;
    }

    switch (user.state as State) {
      case "NEW":
      case "MENU":
      case "PREBOARD":
        return this.handlePreboard(user, batch);
      case "AWAITING_CODE":
        return this.handleCodeText(user, lastOf(batch, "text")?.text);
      case "AWAITING_PAYMENT":
        return this.nudgePayment(user);
      case "SETUP":
        return this.handleSetup(user, batch);
      case "CONFIRM_DELETE":
        return this.cancelDelete(user);
      case "READY":
        return this.handleReady(user, batch);
      default:
        return this.showMenu(user);
    }
  }

  // ---- menu & onboarding -------------------------------------------------------------------------------------------

  private menuFor(user: UserRow) {
    return user.plan ? copy.MENU_RETURNING : copy.MENU_NEW;
  }

  private async showMenu(user: UserRow): Promise<void> {
    if (hasAccess(user)) {
      const updated = user.state === "READY" ? user : await updateUser(user.id, { state: "READY", stateData: {} });
      await this.showQuickMenu(updated);
      return;
    }
    const updated = user.state === "PREBOARD" ? user : await updateUser(user.id, { state: "PREBOARD", stateData: {} });
    await this.d.outbox.buttons(updated, copy.TEXT.menuPrompt, this.menuFor(updated));
  }

  /**
   * Before someone has access there is no feature tour and no numbered choices: a short hello, then a bounded model
   * that answers what Milo is, what it costs and what happens to their data, and nothing else.
   */
  private async handlePreboard(user: UserRow, batch: PendingMessage[]): Promise<void> {
    const text = lastOf(batch, "text")?.text.trim() ?? "";
    if (text && looksLikeCode(text) && (await findCode(text))) return this.applyCode(user, text);

    if (user.state !== "PREBOARD") {
      const updated = await updateUser(user.id, { state: "PREBOARD", stateData: {} });
      await this.d.outbox.text(updated, copy.welcome(updated.displayName), { raw: true });
      if (!text || GREETING.test(text)) return;
      return this.answerPreboard(updated, text);
    }

    // They kept chatting after the notice in the hello, which is the consent that notice describes.
    const updated = user.consentAt ? user : await updateUser(user.id, { consentAt: new Date() });
    if (!text) {
      await this.d.outbox.text(updated, copy.TEXT.preboardFallback, { raw: true });
      return;
    }
    return this.answerPreboard(updated, text);
  }

  private async answerPreboard(user: UserRow, text: string): Promise<void> {
    const outcome = await preboardReply(user, text, { agent: this.d.agent, log: this.d.log });
    if (!outcome) {
      await this.d.outbox.text(user, copy.TEXT.preboardFallback, { raw: true });
      return;
    }
    if (outcome.text) await this.d.outbox.text(user, outcome.text, { raw: true });
    if (outcome.checkout) await this.startCheckout(user.consentAt ? user : await updateUser(user.id, { consentAt: new Date() }));
  }

  private async handleButton(user: UserRow, id: string): Promise<void> {
    const relay = /^relay_(send|cancel):(\d+)$/.exec(id);
    if (relay) return this.handleRelayButton(user, relay[1] as "send" | "cancel", relay[2]!);
    if (id.startsWith("qa:")) {
      const action = id.slice(3) as QuickAction;
      if (QUICK_ACTIONS.has(action)) return this.handleQuickAction(user, action);
    }
    if (id.startsWith("setup:")) return this.handleSetupButton(user, id.slice(6));
    if (id.startsWith("conn:")) return this.handleConnectButton(user, id.slice(5));
    const act = /^act_(yes|no):(\d+)$/.exec(id);
    if (act) return this.handleActionButton(user, act[1] === "yes", act[2]!);
    const consent = user.consentAt ? {} : { consentAt: new Date() };
    switch (id) {
      case copy.BTN.code.id: {
        const updated = await updateUser(user.id, {
          ...consent,
          state: "AWAITING_CODE",
          stateData: { codeTries: 0, returnTo: user.state === "AWAITING_CODE" ? "MENU" : user.state },
        });
        await this.d.outbox.text(updated, copy.TEXT.codePrompt, { raw: true });
        return;
      }
      case copy.BTN.price.id:
        if (!user.consentAt) await updateUser(user.id, consent);
        await this.d.outbox.text(user, copy.pricing(), { raw: true });
        await this.d.outbox.buttons(user, copy.TEXT.afterInfo, copy.MENU_PRICING);
        return;
      case copy.BTN.faq.id:
        await this.d.outbox.text(user, copy.FAQ, { raw: true });
        await this.d.outbox.buttons(user, copy.TEXT.afterInfo, [copy.BTN.code, copy.BTN.price]);
        return;
      case copy.BTN.subscribe.id:
        return this.startCheckout(await updateUser(user.id, consent));
      case copy.BTN.executive.id: {
        const updated = await updateUser(user.id, {
          ...consent,
          stateData: { ...user.stateData, executiveInterestAt: new Date().toISOString() },
        });
        this.d.log.info({ userId: user.id, waId: user.waId }, "prospek Eksekutif");
        await this.d.outbox.text(updated, copy.TEXT.executiveLead, { raw: true });
        return;
      }
      case copy.BTN.resendQr.id: {
        const pending = await this.d.payments.pendingFor(user.id);
        if (pending && pending.expiresAt.getTime() > Date.now()) {
          await this.d.payments.sendQr(user, pending);
          return;
        }
        return this.startCheckout(user);
      }
      case copy.BTN.cancelPay.id: {
        await this.d.payments.cancelPending(user.id);
        const updated = await updateUser(user.id, { state: hasAccess(user) ? "READY" : "MENU", stateData: {} });
        await this.d.outbox.text(updated, copy.TEXT.paymentCancelled, { raw: true });
        if (!hasAccess(updated)) await this.d.outbox.buttons(updated, copy.TEXT.menuPrompt, this.menuFor(updated));
        return;
      }
      case copy.BTN.deleteYes.id:
        if (user.state === "CONFIRM_DELETE") return this.deleteEverything(user);
        return this.showMenu(user);
      case copy.BTN.deleteNo.id:
        return this.cancelDelete(user);
      default:
        return hasAccess(user) && user.state === "READY" ? undefined : this.showMenu(user);
    }
  }

  private async handleCodeText(user: UserRow, text: string | undefined): Promise<void> {
    if (!text) {
      await this.d.outbox.text(user, copy.TEXT.codePrompt, { raw: true });
      return;
    }
    return this.applyCode(user, text);
  }

  private async applyCode(user: UserRow, text: string): Promise<void> {
    const result = await redeem(user.id, text);
    if (!result.ok) {
      const tries = Number(user.stateData.codeTries ?? 0) + 1;
      if (tries >= 3) {
        const updated = await updateUser(user.id, { state: hasAccess(user) ? "READY" : "MENU", stateData: {} });
        await this.d.outbox.buttons(updated, copy.TEXT.codeGiveUp, [copy.BTN.subscribe, copy.BTN.price, copy.BTN.faq]);
        return;
      }
      const updated = await updateUser(user.id, {
        state: "AWAITING_CODE",
        stateData: { ...user.stateData, codeTries: tries },
      });
      await this.d.outbox.buttons(updated, copy.TEXT.codeInvalid, [copy.BTN.price, copy.BTN.faq]);
      return;
    }

    const consent = user.consentAt ? {} : { consentAt: new Date() };
    if (result.code.kind === "pendiri") {
      const updated = await updateUser(user.id, { ...consent, stateData: {} });
      await this.d.outbox.text(updated, copy.pendiriAccepted(), { raw: true });
      await this.checkout(updated, "pendiri");
      return;
    }

    if (user.trialEndsAt) {
      const updated = await updateUser(user.id, { ...consent, state: hasAccess(user) ? "READY" : "MENU", stateData: {} });
      await this.d.outbox.buttons(updated, copy.TEXT.trialUsed, [copy.BTN.subscribe, copy.BTN.price]);
      return;
    }
    const days = result.code.trialDays ?? config.TRIAL_DAYS;
    const endsAt = addDays(new Date(), days);
    const updated = await updateUser(user.id, {
      ...consent,
      status: "trialing",
      plan: "trial",
      trialEndsAt: endsAt,
      state: "READY",
      stateData: {},
    });
    if (config.TRIAL_NUDGE_DAY < days) {
      await sql`
        insert into reminders (user_id, kind, text, fire_at)
        values (${user.id}, 'trial_nudge', 'trial_nudge', ${addDays(new Date(), config.TRIAL_NUDGE_DAY)})
      `;
    }
    await this.afterActivation(updated, copy.trialStarted(days, endsAt, updated.timezone));
  }

  private async startCheckout(user: UserRow): Promise<void> {
    const plan = (await hasPendiriRedemption(user.id)) ? "pendiri" : "profesional";
    return this.checkout(user, plan);
  }

  private async checkout(user: UserRow, plan: "pendiri" | "profesional"): Promise<void> {
    const active = hasAccess(user);
    const updated = active ? user : await updateUser(user.id, { state: "AWAITING_PAYMENT", stateData: { plan } });
    await this.d.payments.checkout(updated, plan);
    await this.d.outbox.buttons(
      updated,
      active ? "Setelah pembayaran masuk, masa aktif Anda langsung diperpanjang." : "Setelah pembayaran masuk, Milo langsung aktif.",
      [copy.BTN.resendQr, copy.BTN.cancelPay],
    );
  }

  private async nudgePayment(user: UserRow): Promise<void> {
    const pending = await this.d.payments.pendingFor(user.id);
    if (!pending) {
      const updated = await updateUser(user.id, { state: hasAccess(user) ? "READY" : "MENU", stateData: {} });
      await this.d.outbox.buttons(updated, copy.TEXT.menuPrompt, this.menuFor(updated));
      return;
    }
    await this.d.outbox.buttons(user, copy.TEXT.awaitingPayment, [copy.BTN.resendQr, copy.BTN.cancelPay]);
  }

  // ---- opt-out & deletion ------------------------------------------------------------------------------------------

  private async optOut(user: UserRow): Promise<void> {
    await sql`update reminders set status = 'cancelled' where user_id = ${user.id} and status = 'scheduled'`;
    const updated = await updateUser(user.id, {
      state: "OPTED_OUT",
      stateData: { previousStatus: user.status },
      status: "opted_out",
    });
    await this.d.outbox.text(updated, copy.TEXT.optedOut, { raw: true });
  }

  private async resume(user: UserRow): Promise<void> {
    const previous = user.stateData.previousStatus as UserRow["status"] | undefined;
    const restored = await updateUser(user.id, {
      status: previous && previous !== "opted_out" ? previous : "new",
      state: "MENU",
      stateData: {},
    });
    return this.showMenu(restored);
  }

  private async confirmDelete(user: UserRow): Promise<void> {
    const updated = await updateUser(user.id, {
      state: "CONFIRM_DELETE",
      stateData: { returnTo: user.state === "CONFIRM_DELETE" ? "MENU" : user.state },
    });
    await this.d.outbox.buttons(updated, copy.TEXT.deleteConfirm, [copy.BTN.deleteYes, copy.BTN.deleteNo]);
  }

  private async cancelDelete(user: UserRow): Promise<void> {
    const back = (user.stateData.returnTo as State | undefined) ?? "MENU";
    const state = back === "READY" && !hasAccess(user) ? "MENU" : back;
    const updated = await updateUser(user.id, { state, stateData: {} });
    await this.d.outbox.text(updated, copy.TEXT.deleteCancelled, { raw: true });
  }

  private async deleteEverything(user: UserRow): Promise<void> {
    await disconnectGoogle(user.id).catch((err) => this.d.log.warn({ err, userId: user.id }, "pencabutan akses Google gagal"));
    await deleteUserMedia(user.id);
    await sql`delete from users where id = ${user.id}`;
    this.d.log.info({ userId: user.id }, "data pengguna dihapus atas permintaan");
    await this.d.wa.sendText(user.waId, copy.TEXT.deleted);
  }

  // ---- active users ------------------------------------------------------------------------------------------------

  private async handleReady(user: UserRow, incoming: PendingMessage[]): Promise<void> {
    if (!hasAccess(user)) {
      const updated = await updateUser(user.id, { status: "expired", state: "MENU", stateData: {} });
      const endedAt = user.plan === "trial" ? user.trialEndsAt : user.periodEndsAt;
      await this.d.outbox.buttons(updated, copy.accessExpired(endedAt, user.timezone), copy.MENU_RETURNING);
      return;
    }
    const actionOf = (m: PendingMessage) => (m.inbound.kind === "text" ? keywordAction(m.inbound.text) : undefined);
    for (const action of new Set(incoming.map(actionOf))) {
      if (action) await this.handleQuickAction(user, action);
    }
    const batch = incoming.filter((m) => !actionOf(m));

    const notes: string[] = [];
    const replies: string[] = [];
    const questions: string[] = [];

    for (const { inbound } of batch) {
      switch (inbound.kind) {
        case "text":
          if (inbound.text.trim()) questions.push(inbound.text.trim());
          break;
        case "button":
          questions.push(inbound.title);
          break;
        case "document":
        case "image":
        case "video": {
          try {
            const { capture, note } = await saveMediaCapture(this.d.wa, user.id, inbound);
            const pages = capture.pageCount ? `, ${capture.pageCount} hlm` : "";
            const label = inbound.kind === "image" ? "Foto" : inbound.kind === "video" ? "Video" : "Dokumen";
            notes.push(`[${label} tersimpan #${capture.id}: ${capture.title}${pages}${note ? ` — ${note}` : ""}]`);
            const icon = inbound.kind === "image" ? "🖼️" : "📎";
            const scan = capture.status !== "ready" && note ? `\n_Catatan: ${note}, jadi isinya belum bisa saya baca._` : "";
            replies.push(`${icon} Tersimpan: *${capture.title}*${pages} (#${capture.id}).${scan}`);
            if (inbound.caption?.trim()) questions.push(inbound.caption.trim());
          } catch (err) {
            await discardInboundMedia(inbound.mediaId).catch(() => {});
            this.d.log.warn({ err, userId: user.id }, "gagal menyimpan media");
            replies.push(`Maaf, file itu gagal saya simpan (${errorMessage(err)}).`);
          }
          break;
        }
        case "audio": {
          if (!sttEnabled()) {
            await discardInboundMedia(inbound.mediaId);
            replies.push(copy.TEXT.voiceDisabled);
            break;
          }
          try {
            const media = await loadInboundMedia(this.d.wa, inbound.mediaId, 25 * 1024 * 1024, inbound.mime);
            await discardInboundMedia(inbound.mediaId);
            const t = await transcribe(media.data, inbound.mime ?? media.mimeType);
            await sql`
              insert into usage_ledger (user_id, kind, model, units, cost_usd)
              values (${user.id}, 'stt', ${config.STT_MODEL}, ${t.durationSeconds}, ${t.costUsd})
            `;
            const title = `Pesan suara ${formatDate(new Date(), user.timezone)}`;
            const capture = await saveTextCapture(user.id, { kind: "audio", title, text: t.text, mime: inbound.mime });
            if (t.durationSeconds > config.VOICE_MAX_SECONDS) {
              const minutes = Math.round(t.durationSeconds / 60);
              notes.push(`[Rekaman ${minutes} menit tersimpan sebagai catatan #${capture.id}]`);
              replies.push(`🎙️ Rekaman ${minutes} menit tersimpan sebagai catatan #${capture.id}. Mau saya ringkas?`);
            } else if (t.text) {
              questions.push(`[Pesan suara, ditranskrip otomatis] ${t.text}`);
            } else {
              replies.push("Pesan suaranya tidak terdengar jelas. Bisa diulang?");
            }
          } catch (err) {
            this.d.log.warn({ err, userId: user.id }, "gagal mentranskrip pesan suara");
            replies.push("Maaf, pesan suara itu gagal saya dengarkan. Coba kirim ulang atau ketik saja.");
          }
          break;
        }
        case "contacts": {
          const saved = await this.saveContacts(user, inbound.contacts);
          if (saved.length) {
            notes.push(`[Kontak tersimpan: ${saved.join(", ")}]`);
            replies.push(
              `👤 Kontak tersimpan: *${saved.join(", ")}*. Kalau ada panggilan khusus, bilang saja — misalnya "${saved[0]} itu PM saya".`,
            );
          }
          break;
        }
        case "location":
          questions.push(
            `[Lokasi dibagikan: ${[inbound.name, inbound.address].filter(Boolean).join(", ") || "tanpa nama"} (${inbound.latitude}, ${inbound.longitude})]`,
          );
          break;
        case "unsupported":
          if (inbound.type === "fonnte-empty") {
            replies.push(copy.attachmentMissing(uploadUrlFor(user.id)));
            notes.push("[Pengguna mengirim file/foto lewat WhatsApp, tapi file dan keterangannya tidak sampai. Link unggah sudah dikirim.]");
          } else if (inbound.type === "vcard-url") {
            replies.push(copy.CONTACT_CARD_MISSING);
            notes.push("[Pengguna membagikan kartu kontak, tapi isinya tidak bisa dibaca di kanal ini. Minta nama dan nomornya sebagai teks, lalu simpan dengan contact_save.]");
          } else {
            replies.push(copy.TEXT.unsupported);
          }
          break;
      }
    }

    if (!questions.length) {
      if (!replies.length) return;
      const reply = [...new Set(replies)].join("\n\n");
      await this.d.outbox.text(user, reply, { raw: true });
      if (notes.length) {
        const model = await this.d.agent.modelFor(user).catch(() => null);
        if (model) await recordStaticExchange(user, model, notes.join("\n"), reply);
      }
      return;
    }

    if (replies.length) await this.d.outbox.text(user, [...new Set(replies)].join("\n\n"), { raw: true });

    const replyNotes = (await takeUnseenReplies(user.id)).map(
      (r) =>
        `[Balasan dari ${r.contactName ? `${r.contactName} (${r.fromWa})` : r.fromWa}, ${formatDateTime(r.createdAt, user.timezone)}: ${r.body}]`,
    );
    notes.unshift(...replyNotes);

    const softMode = await this.softModeFor(user);
    const messaging = messageSendFor(user.waId);
    const relayMark = messaging ? await lastRelayId(user.id) : "0";
    const google = googleEnabled();
    const actionMark = google ? await lastActionId(user.id) : "0";
    const slowNotice =
      config.MILO_SLOW_NOTICE_MS >= 0
        ? setTimeout(() => {
            this.d.outbox.text(user, copy.TEXT.working, { raw: true }).catch(() => {});
          }, config.MILO_SLOW_NOTICE_MS)
        : undefined;
    let result: Awaited<ReturnType<Agent["run"]>>;
    try {
      result = await this.d.agent.run(user, [...notes, ...questions].join("\n"), { softMode });
    } finally {
      clearTimeout(slowNotice);
    }
    this.d.log.info(
      { userId: user.id, runId: result.runId, steps: result.steps, costUsd: Number(result.costUsd.toFixed(6)) },
      "giliran agent selesai",
    );
    await this.d.outbox.text(user, result.reply);

    if (messaging) {
      const draft = await pendingDraftAfter(user.id, relayMark);
      if (draft) await this.askRelayConfirmation(user, draft);
    }
    if (google) {
      const action = await pendingActionAfter(user.id, actionMark);
      if (action) await this.askActionConfirmation(user, action);
    }
  }

  // ---- messages to other people --------------------------------------------------------------------------------------

  private async askRelayConfirmation(user: UserRow, draft: RelayRow): Promise<void> {
    const who = draft.contactName ? `*${draft.contactName}* (${draft.toWa})` : `*${draft.toWa}*`;
    await this.d.outbox.text(user, composeRelayText(user, draft.body), { raw: true });
    await this.d.outbox.buttons(user, copy.relayConfirm(who, CONFIRM_MINUTES), relayButtons(draft.id));
  }

  private async handleRelayButton(user: UserRow, action: "send" | "cancel", id: string): Promise<void> {
    if (!messageSendFor(user.waId) || !hasAccess(user)) return this.showMenu(user);
    let reply: string;
    let note: string;
    if (action === "cancel") {
      const row = await cancelRelay(user, id);
      reply = row ? copy.relayCancelled(row.contactName ?? row.toWa) : copy.TEXT.relayUnavailable;
      note = `[Pengguna menekan Batal: pesan ${row ? `ke ${row.contactName ?? row.toWa} ` : ""}tidak dikirim]`;
    } else {
      const outcome = await confirmRelay(user, id, this.d.wa);
      const name = outcome.row ? (outcome.row.contactName ?? outcome.row.toWa) : "";
      if (outcome.status === "sent") {
        reply = copy.relaySent(name);
        note = `[Pengguna menekan Kirim: pesan ke ${name} terkirim]`;
      } else if (outcome.status === "failed") {
        this.d.log.warn({ userId: user.id, relayId: id, error: outcome.error }, "pesan ke orang lain gagal terkirim");
        reply = copy.relayFailed(name, outcome.error);
        note = `[Pengguna menekan Kirim, tapi pesan ke ${name} gagal terkirim: ${outcome.error}]`;
      } else {
        reply = outcome.row?.status === "sent" ? copy.TEXT.relayAlreadySent : copy.TEXT.relayUnavailable;
        note = "[Pengguna menekan tombol konfirmasi yang sudah tidak berlaku]";
      }
    }
    await this.d.outbox.text(user, reply, { raw: true });
    const model = await this.d.agent.modelFor(user).catch(() => null);
    if (model) await recordStaticExchange(user, model, note, reply);
  }

  /** Someone who is not a Milo user answered a message Milo sent for a user: hand it to that user instead of onboarding. */
  private async forwardRelayReply(sender: UserRow, thread: RelayRow, batch: PendingMessage[]): Promise<void> {
    const parts = batch.map(({ inbound }) => {
      switch (inbound.kind) {
        case "text":
          return inbound.text.trim();
        case "button":
          return inbound.title;
        case "location":
          return `[lokasi: ${inbound.latitude}, ${inbound.longitude}]`;
        case "document":
        case "image":
        case "video":
          return `[mengirim ${inbound.kind === "document" ? "dokumen" : inbound.kind === "image" ? "foto" : "video"}${"caption" in inbound && inbound.caption ? `: ${inbound.caption}` : ""}]`;
        case "audio":
          return "[mengirim pesan suara]";
        case "contacts":
          return `[membagikan kontak: ${inbound.contacts.map((c) => c.name).join(", ")}]`;
        default:
          return "[pesan yang tidak bisa dibaca]";
      }
    });
    for (const { inbound } of batch) {
      if ("mediaId" in inbound) await discardInboundMedia(inbound.mediaId).catch(() => {});
    }
    const body = parts.filter(Boolean).join("\n").slice(0, 3000);
    if (!body) return;
    const first = await recordRelayReply(thread, sender.waId, body);
    const owner = await getUser(thread.ownerId);
    if (owner && owner.state !== "OPTED_OUT" && hasAccess(owner)) {
      const name = thread.contactName ?? sender.displayName ?? sender.waId;
      await this.d.outbox.text(owner, copy.relayReply(name, sender.waId, body), { raw: true });
    }
    if (first && owner) {
      await this.d.outbox.text(sender, copy.relayAck(assistantLabel(owner), ownerLabel(owner)), { raw: true });
    }
    this.d.log.info({ ownerId: thread.ownerId, relayId: thread.id }, "balasan pesan diteruskan ke pengguna");
  }

  // ---- quick actions ---------------------------------------------------------------------------------------------------

  private async showQuickMenu(user: UserRow): Promise<void> {
    const name = user.assistantName ?? DEFAULT_ASSISTANT_NAME;
    await this.d.outbox.list(user, copy.quickMenuIntro(name, user.profile?.callName), QUICK_MENU_LABEL, quickRows(user));
  }

  /** Static replies cost nothing; each is recorded so the model understands what the user answers next. */
  private async replyStatic(user: UserRow, userNote: string, text: string): Promise<void> {
    await this.d.outbox.text(user, text, { raw: true });
    const model = await this.d.agent.modelFor(user).catch(() => null);
    if (model) await recordStaticExchange(user, model, userNote, text);
  }

  private async handleQuickAction(user: UserRow, action: QuickAction): Promise<void> {
    if (!hasAccess(user)) return this.showMenu(user);
    const note = `[Menu: ${action}]`;
    switch (action) {
      case "agenda":
        return this.replyStatic(user, note, await agendaText(user));
      case "reminder":
        return this.replyStatic(user, note, copy.QUICK_PROMPTS.reminder);
      case "message":
        return this.replyStatic(user, note, copy.QUICK_PROMPTS.message);
      case "server":
        return this.replyStatic(user, note, copy.QUICK_PROMPTS.server);
      case "file":
        return this.replyStatic(user, note, copy.uploadLink(uploadUrlFor(user.id), config.UPLOAD_LINK_HOURS));
      case "connect":
        return this.showConnections(user);
      case "style":
        return this.replyStatic(user, note, personaMenu(user.assistantName ?? DEFAULT_ASSISTANT_NAME, findPersona(user.persona)));
      case "help":
        return this.replyStatic(user, note, helpFor(user));
      case "profile": {
        const facts = await sql<{ fact: string }[]>`select fact from facts where user_id = ${user.id} order by id desc limit 30`;
        await this.replyStatic(user, note, profileSummary(user, facts.map((f) => f.fact)));
        await this.d.outbox.buttons(user, "Mau mengulang perkenalan dari awal?", [copy.SETUP_BTN.restart]);
        return;
      }
      case "account": {
        const until = user.plan === "trial" ? user.trialEndsAt : user.periodEndsAt;
        await this.d.outbox.buttons(user, copy.accountSummary(user.plan, until, user.timezone), [
          copy.BTN.subscribe,
          copy.BTN.price,
          copy.BTN.faq,
        ]);
        return;
      }
    }
  }

  // ---- connected accounts ------------------------------------------------------------------------------------------------

  private async showConnections(user: UserRow): Promise<void> {
    const lines = ["🔗 *Koneksi akun*"];
    const rows = [];
    if (googleEnabled()) {
      const account = await getAccount(user.id);
      const granted = account ? servicesGranted(account.scopes) : [];
      if (!account) {
        lines.push("Google: belum terhubung.");
      } else if (account.status !== "active") {
        lines.push(`Google: ⚠️ ${account.email ?? "akun"}, login kedaluwarsa.`);
        rows.push({ id: "conn:google:relogin", title: "🔄 Login ulang Google", description: "Sambungkan lagi akun yang sama" });
      } else {
        lines.push(`Google: ✅ ${account.email ?? "terhubung"} — ${granted.map((s) => SERVICE_LABEL[s]).join(", ") || "tanpa layanan"}.`);
      }
      const missing = enabledServices().filter((s) => !granted.includes(s));
      if (!account && missing.length > 1) {
        rows.push({ id: "conn:google:all", title: "🔗 Semua akun Google", description: "Kalender, Gmail, dan Drive sekaligus" });
      }
      rows.push(...missing.map((s) => CONNECT_ROWS[s]));
      if (account) rows.push({ id: "conn:google:disconnect", title: "❌ Putuskan Google", description: "Cabut akses Milo ke akun Google Anda" });
    }
    if (serverToolsFor(user.waId)) {
      const servers = await listUserServers(user.id);
      lines.push(
        servers.length
          ? `Server: ${servers.map((s) => `${s.name} ${s.verifiedAt ? "✅" : "⏳"}`).join(", ")}.`
          : "Server: belum ada.",
      );
      rows.push({ id: "conn:server", title: "🖥️ Tambah server", description: "Hubungkan server Linux Anda" });
    }
    const text = lines.join("\n");
    if (rows.length) await this.d.outbox.list(user, `${text}\n\nPilih di bawah:`, "Pilih", rows.slice(0, 10));
    else await this.d.outbox.text(user, text, { raw: true });
    const model = await this.d.agent.modelFor(user).catch(() => null);
    if (model) await recordStaticExchange(user, model, "[Menu: koneksi]", text);
  }

  private async handleConnectButton(user: UserRow, action: string): Promise<void> {
    if (!hasAccess(user)) return this.showMenu(user);
    if (action === "server") return this.connectChoice(user, "server");
    const [kind, value] = action.split(":");
    if (kind !== "google" || !value) return this.showQuickMenu(user);
    if (value === "disconnect") {
      const removed = await disconnectGoogle(user.id);
      await closeSessions(user.id);
      return this.replyStatic(user, "[Menu: putuskan Google]", removed ? copy.CONNECT_TEXT.disconnected : copy.CONNECT_TEXT.notConnected);
    }
    if (value === "relogin") {
      const account = await getAccount(user.id);
      const granted = account ? servicesGranted(account.scopes) : [];
      return this.sendConnectLink(user, granted.length ? granted : enabledServices());
    }
    if (value === "all") return this.connectChoice(user, "google");
    if ((enabledServices() as string[]).includes(value)) return this.connectChoice(user, value as GoogleService);
    return this.showQuickMenu(user);
  }

  private async connectChoice(user: UserRow, choice: ConnectChoice): Promise<void> {
    if (choice === "server") {
      await this.replyStatic(user, "[Menu: hubungkan server]", copy.CONNECT_TEXT.server);
    } else if (googleEnabled()) {
      await this.sendConnectLink(user, choice === "google" ? enabledServices() : [choice]);
    }
    if (user.state === "SETUP") await this.finishSetup(user);
  }

  private async sendConnectLink(user: UserRow, services: GoogleService[]): Promise<void> {
    const url = connectUrlFor(user.id, services);
    const text = copy.connectLink(url, services.map((s) => SERVICE_LABEL[s]), CONNECT_MINUTES);
    await this.replyStatic(user, `[Menu: hubungkan ${services.join(", ")}]`, text);
  }

  /** Called by the OAuth callback, outside this user's message queue: no transcript writes here. */
  async googleConnected(result: AuthResult): Promise<void> {
    const user = await getUser(result.userId);
    if (!user || user.state === "OPTED_OUT") return;
    const missing = result.requested.filter((s) => !result.granted.includes(s));
    const examples = [
      ...(result.granted.includes("calendar") ? ["agenda saya minggu ini apa?"] : []),
      ...(result.granted.includes("gmail") ? ["ada email penting hari ini?"] : []),
      ...(result.granted.includes("drive") ? ["cari file proposal di Drive"] : []),
    ];
    await closeSessions(user.id);
    await this.d.outbox.text(
      user,
      copy.googleConnected(
        result.email,
        result.granted.map((s) => SERVICE_LABEL[s]),
        missing.map((s) => SERVICE_LABEL[s]),
        examples,
      ),
      { raw: true },
    );
    this.d.log.info({ userId: user.id, granted: result.granted }, "akun Google terhubung");
  }

  // ---- actions that wait for a tap -------------------------------------------------------------------------------------

  private async askActionConfirmation(user: UserRow, action: PendingAction): Promise<void> {
    await this.d.outbox.text(user, actionPreview(action, user), { raw: true });
    await this.d.outbox.buttons(user, await actionQuestion(action, user), actionButtons(action));
  }

  private async handleActionButton(user: UserRow, yes: boolean, id: string): Promise<void> {
    if (!hasAccess(user)) return this.showMenu(user);
    if (!yes) {
      const cancelled = await cancelAction(user.id, id);
      const text = cancelled ? copy.CONNECT_TEXT.actionCancelled : copy.CONNECT_TEXT.actionUnavailable;
      return this.replyStatic(user, `[Pengguna menekan Batal${cancelled ? `: ${cancelled.kind} tidak dijalankan` : ""}]`, text);
    }
    const action = await claimAction(user.id, id);
    if (!action) {
      const existing = await getAction(user.id, id);
      const text = existing?.status === "done" ? copy.CONNECT_TEXT.actionDone : copy.CONNECT_TEXT.actionUnavailable;
      return this.replyStatic(user, "[Pengguna menekan tombol konfirmasi yang sudah tidak berlaku]", text);
    }
    const outcome = await runAction(action, user);
    await finishAction(action.id, outcome.ok ? "done" : "failed", outcome.text);
    if (!outcome.ok) this.d.log.warn({ userId: user.id, actionId: id, kind: action.kind }, "aksi Google gagal");
    await this.replyStatic(user, outcome.note, outcome.text);
  }

  // ---- getting to know the user ------------------------------------------------------------------------------------------

  /** Called when access starts, by a trial code here or by a payment in Payments. */
  async afterActivation(user: UserRow, lead: string): Promise<void> {
    if (user.profile?.setupDoneAt) {
      await this.d.outbox.text(user, lead, { raw: true });
      await this.showQuickMenu(user);
      return;
    }
    await this.startSetup(user, lead);
  }

  private async startSetup(user: UserRow, lead?: string): Promise<void> {
    const updated = await updateUser(user.id, { state: "SETUP", stateData: { setupStep: "callName" } });
    if (lead) await this.d.outbox.text(updated, lead, { raw: true });
    await this.askSetupStep(updated, "callName");
  }

  /** Three plain questions, answered in the user's own words: no numbers, no buttons, nothing to tap. */
  private async askSetupStep(user: UserRow, step: SetupStep): Promise<void> {
    switch (step) {
      case "callName": {
        const own = user.displayName ? normalizeCallName(user.displayName) : undefined;
        return this.d.outbox.text(user, copy.SETUP.callName(own), { raw: true });
      }
      case "work":
        return this.d.outbox.text(user, copy.SETUP.work, { raw: true });
      case "connect":
        return this.d.outbox.text(user, copy.SETUP.connect, { raw: true });
    }
  }

  private currentStep(user: UserRow): SetupStep {
    return isSetupStep(user.stateData.setupStep) ? user.stateData.setupStep : "callName";
  }

  private async handleSetup(user: UserRow, batch: PendingMessage[]): Promise<void> {
    if (!hasAccess(user)) return this.handleReady(user, batch);
    const step = this.currentStep(user);
    const texts = batch.filter((m) => m.inbound.kind === "text");
    const answer = texts.length === batch.length ? (lastOf(batch, "text")?.text.trim() ?? "") : "";
    if (!answer || keywordAction(answer) || looksLikeRequest(answer, step)) {
      return this.pauseSetup(user, batch);
    }
    if (FINISH.test(answer)) return this.finishSetup(user);
    if (SKIP.test(answer)) return this.advanceSetup(user, step);

    switch (step) {
      case "callName": {
        const callName = normalizeCallName(answer);
        if (!callName) return this.replySetupRetry(user, copy.SETUP.retryCallName);
        await updateProfile(user.id, { callName });
        return this.advanceSetup(user, step);
      }
      case "work": {
        const work = normalizeWork(answer);
        if (!work) return this.replySetupRetry(user, copy.SETUP.retryWork);
        await updateProfile(user.id, { work });
        return this.advanceSetup(user, step);
      }
      case "connect": {
        const choice = parseConnectChoice(answer);
        if (choice) return this.connectChoice(user, choice);
        if (isYes(answer)) return this.connectChoice(user, "google");
        return this.finishSetup(user);
      }
    }
  }

  private async replySetupRetry(user: UserRow, text: string): Promise<void> {
    await this.d.outbox.text(user, text, { raw: true });
  }

  private async handleSetupButton(user: UserRow, action: string): Promise<void> {
    if (!hasAccess(user)) return this.showMenu(user);
    if (action === "restart") return this.startSetup(user);
    if (user.state !== "SETUP") return this.showQuickMenu(user);
    return this.askSetupStep(user, this.currentStep(user));
  }

  private async advanceSetup(user: UserRow, from: SetupStep): Promise<void> {
    const next = nextStep(from, withConnectStep(user));
    if (!next) return this.finishSetup(user);
    const updated = await updateUser(user.id, { stateData: { ...user.stateData, setupStep: next } });
    await this.askSetupStep(updated, next);
  }

  private async finishSetup(user: UserRow): Promise<void> {
    await updateProfile(user.id, { setupDoneAt: new Date().toISOString() });
    const updated = await updateUser(user.id, { state: "READY", stateData: {} });
    await closeSessions(user.id);
    await this.d.outbox.text(updated, copy.setupDone(updated.profile?.callName), { raw: true });
  }

  /** Something other than an answer arrived: stop asking and treat it as a normal message. */
  private async pauseSetup(user: UserRow, batch: PendingMessage[]): Promise<void> {
    const updated = await updateUser(user.id, { state: "READY", stateData: {} });
    await closeSessions(user.id);
    await this.d.outbox.text(updated, copy.SETUP.paused, { raw: true });
    await this.handleReady(updated, batch);
  }

  private async softModeFor(user: UserRow): Promise<boolean> {
    if (user.plan === "eksekutif") return false;
    const quota = await quotaState(user);
    if (!quota.exceeded) return false;
    const noticed = typeof user.stateData.softNoticeAt === "string" ? new Date(user.stateData.softNoticeAt) : null;
    if (!noticed || Date.now() - noticed.getTime() > 30 * 86_400_000) {
      await updateUser(user.id, { stateData: { ...user.stateData, softNoticeAt: new Date().toISOString() } });
      await this.d.outbox.text(user, copy.TEXT.softMode, { raw: true });
    }
    return true;
  }

  private async saveContacts(user: UserRow, contacts: SharedContact[]): Promise<string[]> {
    const saved: string[] = [];
    for (const c of contacts) {
      const phone = c.phones.map(normalizePhone).find(Boolean) ?? null;
      const email = c.emails[0] ?? null;
      if (phone) {
        await sql`
          insert into contacts (user_id, name, phone, email) values (${user.id}, ${c.name}, ${phone}, ${email})
          on conflict (user_id, phone) do update set name = excluded.name, email = coalesce(excluded.email, contacts.email)
        `;
      } else {
        await sql`insert into contacts (user_id, name, email) values (${user.id}, ${c.name}, ${email})`;
      }
      saved.push(c.name);
    }
    return saved;
  }
}
