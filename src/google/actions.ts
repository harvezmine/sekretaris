import { ACTION_MINUTES, type PendingAction } from "../actions/pending.js";
import type { UserRow } from "../db/index.js";
import { createEvent, deleteEvent, eventLine, eventTime, type NewEvent } from "./calendar.js";
import { accountName, getAccount, GoogleApiError, GoogleAuthError, GoogleNotConnectedError, withAccount } from "./client.js";
import { sendMail, type SendRequest } from "./gmail.js";

export interface MailPayload extends SendRequest {
  replyToFrom?: string | undefined;
}

/** The kinds this file handles; a server run is confirmed the same way but executed elsewhere. */
export type GoogleAction = PendingAction & { kind: "gmail_send" | "calendar_invite" | "calendar_delete" };

export function isGoogleAction(action: PendingAction): action is GoogleAction {
  return action.kind !== "server_run";
}

/** Which Google account this was prepared on, when the user has more than one. */
function accountOf(action: GoogleAction): string | undefined {
  const named = (action.payload as { account?: unknown }).account;
  return typeof named === "string" && named ? named : undefined;
}

export interface DeletePayload {
  eventId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  attendees: number;
}

export function actionPreview(action: GoogleAction, user: UserRow): string {
  const tz = user.timezone;
  switch (action.kind) {
    case "gmail_send": {
      const p = action.payload as unknown as MailPayload;
      return [
        p.replyToFrom ? `📧 *Balasan email siap dikirim* (ke ${p.replyToFrom})` : "📧 *Email siap dikirim*",
        `Kepada: ${p.to.join(", ")}`,
        ...(p.cc?.length ? [`Cc: ${p.cc.join(", ")}`] : []),
        `Subjek: ${p.subject}`,
        "",
        p.body,
      ].join("\n");
    }
    case "calendar_invite": {
      const p = action.payload as unknown as NewEvent;
      return [
        "📅 *Undangan siap dikirim*",
        `*${p.title}*`,
        eventTime({ start: new Date(p.start), end: new Date(p.end), allDay: false }, tz, true),
        ...(p.location ? [`📍 ${p.location}`] : []),
        `Tamu: ${(p.attendees ?? []).join(", ")} _(akan menerima email undangan)_`,
        ...(p.addMeet ? ["Link Google Meet dibuat otomatis."] : []),
        ...(p.description ? ["", p.description] : []),
      ].join("\n");
    }
    case "calendar_delete": {
      const p = action.payload as unknown as DeletePayload;
      const when = eventTime({ start: new Date(p.start), end: new Date(p.end), allDay: p.allDay }, tz, true);
      return [
        "🗑️ *Hapus acara ini dari kalender?*",
        `*${p.title}*, ${when}`,
        ...(p.attendees ? [`${p.attendees} tamu akan diberi tahu bahwa acara dibatalkan.`] : []),
      ].join("\n");
    }
  }
}

export async function actionQuestion(action: GoogleAction, user: UserRow): Promise<string> {
  const account = await getAccount(user.id, accountOf(action));
  const from = account?.email ? ` dari ${account.email}` : "";
  const on = account && !account.isPrimary ? ` di kalender ${accountName(account)}` : "";
  const ask =
    action.kind === "gmail_send"
      ? `Kirim email di atas${from}?`
      : action.kind === "calendar_invite"
        ? `Buat acara ini${on} dan kirim undangannya?`
        : `Hapus acara ini${on}?`;
  return `${ask} Saya tunggu jawaban Anda ${ACTION_MINUTES} menit.`;
}

export interface ActionOutcome {
  ok: boolean;
  /** Shown to the user. */
  text: string;
  /** Recorded for the model. */
  note: string;
}

export async function runAction(action: GoogleAction, user: UserRow): Promise<ActionOutcome> {
  // Whatever the user's default is now, this runs on the account the message was written on.
  return withAccount(accountOf(action), () => perform(action, user));
}

async function perform(action: GoogleAction, user: UserRow): Promise<ActionOutcome> {
  try {
    switch (action.kind) {
      case "gmail_send": {
        const p = action.payload as unknown as MailPayload;
        await sendMail(user.id, p);
        return { ok: true, text: `✅ Email "${p.subject}" terkirim ke ${p.to.join(", ")}.`, note: `[Pengguna menyetujui: email "${p.subject}" terkirim]` };
      }
      case "calendar_invite": {
        const p = action.payload as unknown as NewEvent;
        const event = await createEvent(user.id, user.timezone, p);
        return {
          ok: true,
          text: `✅ Acara dibuat dan undangan terkirim:\n${eventLine(event, user.timezone, true)}${event.meetLink ? `\nMeet: ${event.meetLink}` : ""}`,
          note: `[Pengguna menyetujui undangannya: acara "${p.title}" dibuat, id ${event.id}]`,
        };
      }
      case "calendar_delete": {
        const p = action.payload as unknown as DeletePayload;
        await deleteEvent(user.id, p.eventId, p.attendees > 0);
        return { ok: true, text: `🗑️ Acara *${p.title}* sudah dihapus dari kalender.`, note: `[Pengguna menyetujui: acara "${p.title}" dihapus]` };
      }
    }
  } catch (err) {
    const reason =
      err instanceof GoogleAuthError
        ? "login Google sudah kedaluwarsa, ketik *KONEKSI* untuk login ulang"
        : err instanceof GoogleNotConnectedError
          ? "izin Google untuk ini belum diberikan, ketik *KONEKSI*"
          : err instanceof GoogleApiError
            ? `Google menolak: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
    return { ok: false, text: `❌ Gagal: ${reason}.`, note: `[Pengguna menyetujui, tapi gagal: ${reason}]` };
  }
}
