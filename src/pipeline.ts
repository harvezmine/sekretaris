import { config } from "./config.js";
import { getUser, sql, updateUser, type UserRow } from "./db/index.js";
import type { Agent } from "./agent/run.js";
import { recordStaticExchange } from "./agent/session.js";
import { quotaState } from "./agent/tools.js";
import { deleteUserMedia, discardInboundMedia, loadInboundMedia, saveMediaCapture, saveTextCapture } from "./capture/ingest.js";
import { findCode, hasPendiriRedemption, looksLikeCode, redeem } from "./onboarding/codes.js";
import * as copy from "./onboarding/copy.js";
import { DEFAULT_ASSISTANT_NAME, findPersona, personaMenu } from "./persona/catalog.js";
import {
  activeThreadFor,
  assistantLabel,
  cancelRelay,
  composeRelayText,
  CONFIRM_MINUTES,
  confirmRelay,
  messageSendFor,
  ownerLabel,
  pendingDraftSince,
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

export type State = "NEW" | "MENU" | "AWAITING_CODE" | "AWAITING_PAYMENT" | "READY" | "CONFIRM_DELETE" | "OPTED_OUT";

interface PendingMessage {
  id: string;
  wamid: string;
  inbound: Inbound;
}

const KEYWORDS = ["STOP", "HAPUS", "MULAI", "MENU"] as const;
const STYLE_KEYWORD = /^(gaya|persona)$/i;
const FILE_KEYWORD = /^(file|upload|unggah|kirim file)$/i;
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
        return this.handleMenuText(user, lastOf(batch, "text")?.text);
      case "AWAITING_CODE":
        return this.handleCodeText(user, lastOf(batch, "text")?.text);
      case "AWAITING_PAYMENT":
        return this.nudgePayment(user);
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
      const until = updated.plan === "trial" ? updated.trialEndsAt : updated.periodEndsAt;
      await this.d.outbox.buttons(
        updated,
        `${copy.accountSummary(updated.plan, until, updated.timezone)}\n\nSilakan lanjut mengirim pesan, atau pilih di bawah.`,
        [copy.BTN.subscribe, copy.BTN.price, copy.BTN.faq],
      );
      return;
    }
    if (user.state === "NEW") {
      const updated = await updateUser(user.id, { state: "MENU" });
      await this.d.outbox.buttons(updated, copy.welcome(updated.displayName), copy.MENU_NEW);
      return;
    }
    if (user.state !== "MENU") await updateUser(user.id, { state: "MENU", stateData: {} });
    await this.d.outbox.buttons(user, copy.TEXT.menuPrompt, this.menuFor(user));
  }

  private async handleMenuText(user: UserRow, text: string | undefined): Promise<void> {
    if (text && looksLikeCode(text) && (await findCode(text))) {
      return this.applyCode(user, text);
    }
    if (user.state === "NEW") {
      const updated = await updateUser(user.id, { state: "MENU" });
      await this.d.outbox.buttons(updated, copy.welcome(updated.displayName), copy.MENU_NEW);
      return;
    }
    await this.d.outbox.buttons(user, copy.TEXT.menuPrompt, this.menuFor(user));
  }

  private async handleButton(user: UserRow, id: string): Promise<void> {
    const relay = /^relay_(send|cancel):(\d+)$/.exec(id);
    if (relay) return this.handleRelayButton(user, relay[1] as "send" | "cancel", relay[2]!);
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
    await this.d.outbox.text(updated, copy.trialStarted(days, endsAt, updated.timezone), { raw: true });
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
    const isKeyword = (m: PendingMessage, re: RegExp) => m.inbound.kind === "text" && re.test(m.inbound.text.trim());
    if (incoming.some((m) => isKeyword(m, STYLE_KEYWORD))) await this.showPersonaMenu(user);
    if (incoming.some((m) => isKeyword(m, FILE_KEYWORD))) await this.sendUploadLink(user);
    const batch = incoming.filter((m) => !isKeyword(m, STYLE_KEYWORD) && !isKeyword(m, FILE_KEYWORD));

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
          replies.push(inbound.type === "fonnte-empty" ? copy.attachmentMissing(uploadUrlFor(user.id)) : copy.TEXT.unsupported);
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
    const runStarted = new Date();
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

    if (messageSendFor(user.waId)) {
      const draft = await pendingDraftSince(user.id, runStarted);
      if (draft) await this.askRelayConfirmation(user, draft);
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

  /** Static, so it costs nothing; recorded in the transcript so the agent understands a reply like "nomor 4". */
  private async showPersonaMenu(user: UserRow): Promise<void> {
    const menu = personaMenu(user.assistantName ?? DEFAULT_ASSISTANT_NAME, findPersona(user.persona));
    await this.d.outbox.text(user, menu, { raw: true });
    const model = await this.d.agent.modelFor(user).catch(() => null);
    if (model) await recordStaticExchange(user, model, "GAYA", menu);
  }

  private async sendUploadLink(user: UserRow): Promise<void> {
    const text = copy.uploadLink(uploadUrlFor(user.id), config.UPLOAD_LINK_HOURS);
    await this.d.outbox.text(user, text, { raw: true });
    const model = await this.d.agent.modelFor(user).catch(() => null);
    if (model) await recordStaticExchange(user, model, "FILE", text);
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
