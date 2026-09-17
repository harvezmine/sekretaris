import { config } from "../config.js";
import { sql, type UserRow } from "../db/index.js";
import { DEFAULT_ASSISTANT_NAME } from "../persona/catalog.js";
import { isServerAdmin } from "../servers/registry.js";
import type { Button, WhatsApp } from "../wa/client.js";

/**
 * Messages Milo sends to other people on a user's behalf. The model only creates a draft; sending happens when the
 * user taps Kirim, which the pipeline handles without the model. Replies from the recipient are relayed back.
 */

export const CONFIRM_MINUTES = 15;

export interface RelayRow {
  id: string;
  ownerId: string;
  toWa: string;
  contactName: string | null;
  body: string;
  status: "pending" | "sending" | "sent" | "cancelled" | "failed" | "superseded";
  wamid: string | null;
  error: string | null;
  createdAt: Date;
  expiresAt: Date;
  sentAt: Date | null;
  ackedAt: Date | null;
}

export class RelayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayError";
  }
}

/** Unofficial WhatsApp gateways get numbers banned for unsolicited messages, so this stays on Fonnte and opt-in. */
export function messageSendFor(waId: string): boolean {
  if (config.WA_PROVIDER !== "fonnte") return false;
  switch (config.MESSAGE_SEND_ACCESS) {
    case "all":
      return true;
    case "admin":
      return isServerAdmin(waId);
    default:
      return false;
  }
}

export function ownerLabel(owner: Pick<UserRow, "displayName">): string {
  return owner.displayName?.trim() || "atasan saya";
}

export function assistantLabel(owner: Pick<UserRow, "assistantName">): string {
  return owner.assistantName ?? DEFAULT_ASSISTANT_NAME;
}

export function composeRelayText(owner: Pick<UserRow, "displayName" | "assistantName">, body: string): string {
  return `${body.trim()}\n\n_— ${assistantLabel(owner)}, asisten pribadi ${ownerLabel(owner)}. Balas pesan ini untuk menjawab; balasan Anda akan saya teruskan._`;
}

export function relayButtons(id: string): Button[] {
  return [
    { id: `relay_send:${id}`, title: "Kirim" },
    { id: `relay_cancel:${id}`, title: "Batal" },
  ];
}

export async function draftRelay(
  owner: UserRow,
  input: { toWa: string; contactName: string | null; body: string },
): Promise<RelayRow> {
  if (input.toWa === owner.waId) throw new RelayError("Itu nomor pengguna sendiri. Untuk mengingatkan diri sendiri, pakai pengingat.");
  const [recipient] = await sql<{ state: string }[]>`select state from users where wa_id = ${input.toWa}`;
  if (recipient?.state === "OPTED_OUT") {
    throw new RelayError("Penerima ini sudah meminta agar tidak dikirimi pesan lagi oleh Milo (STOP), jadi pesannya tidak bisa dikirim.");
  }
  const [{ n } = { n: "0" }] = await sql<{ n: string }[]>`
    select count(*) as n from relay_messages
    where owner_id = ${owner.id} and status = 'sent' and sent_at > now() - interval '24 hours'
  `;
  if (Number(n) >= config.MESSAGE_SEND_DAILY_LIMIT) {
    throw new RelayError(`Batas ${config.MESSAGE_SEND_DAILY_LIMIT} pesan ke orang lain per 24 jam sudah tercapai. Pakai message_draft agar pengguna mengirim sendiri.`);
  }
  await sql`update relay_messages set status = 'superseded' where owner_id = ${owner.id} and status = 'pending'`;
  const [row] = await sql<RelayRow[]>`
    insert into relay_messages (owner_id, to_wa, contact_name, body, expires_at)
    values (${owner.id}, ${input.toWa}, ${input.contactName}, ${input.body.trim()}, now() + ${`${CONFIRM_MINUTES} minutes`}::interval)
    returning *
  `;
  return row!;
}

export async function pendingDraftSince(ownerId: string, since: Date): Promise<RelayRow | undefined> {
  const [row] = await sql<RelayRow[]>`
    select * from relay_messages
    where owner_id = ${ownerId} and status = 'pending' and created_at >= ${since} and expires_at > now()
    order by id desc limit 1
  `;
  return row;
}

export type ConfirmOutcome =
  | { status: "sent"; row: RelayRow }
  | { status: "failed"; row: RelayRow; error: string }
  | { status: "unavailable"; row: RelayRow | undefined };

export async function confirmRelay(owner: UserRow, id: string, wa: WhatsApp): Promise<ConfirmOutcome> {
  const [claimed] = await sql<RelayRow[]>`
    update relay_messages set status = 'sending'
    where id = ${id} and owner_id = ${owner.id} and status = 'pending' and expires_at > now()
    returning *
  `;
  if (!claimed) {
    const [row] = await sql<RelayRow[]>`select * from relay_messages where id = ${id} and owner_id = ${owner.id}`;
    return { status: "unavailable", row };
  }
  try {
    const wamid = await wa.sendText(claimed.toWa, composeRelayText(owner, claimed.body));
    const [sent] = await sql<RelayRow[]>`
      update relay_messages set status = 'sent', wamid = ${wamid}, sent_at = now() where id = ${id} returning *
    `;
    return { status: "sent", row: sent! };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const [failed] = await sql<RelayRow[]>`
      update relay_messages set status = 'failed', error = ${error.slice(0, 500)} where id = ${id} returning *
    `;
    return { status: "failed", row: failed!, error };
  }
}

export async function cancelRelay(owner: UserRow, id: string): Promise<RelayRow | undefined> {
  const [row] = await sql<RelayRow[]>`
    update relay_messages set status = 'cancelled'
    where id = ${id} and owner_id = ${owner.id} and status = 'pending'
    returning *
  `;
  return row;
}

/** The most recent message Milo sent to this number, if it is recent enough for a reply to belong to it. */
export async function activeThreadFor(fromWa: string): Promise<RelayRow | undefined> {
  const [row] = await sql<RelayRow[]>`
    select r.* from relay_messages r join users o on o.id = r.owner_id
    where r.to_wa = ${fromWa} and r.status = 'sent' and o.wa_id <> ${fromWa}
      and r.sent_at > now() - ${`${config.RELAY_REPLY_HOURS} hours`}::interval
    order by r.sent_at desc limit 1
  `;
  return row;
}

/** Stores a reply for the owner's next turn; true the first time this thread is answered, so the sender is thanked once. */
export async function recordRelayReply(thread: RelayRow, fromWa: string, body: string): Promise<boolean> {
  await sql`
    insert into relay_replies (relay_id, owner_id, from_wa, body) values (${thread.id}, ${thread.ownerId}, ${fromWa}, ${body})
  `;
  const acked = await sql`update relay_messages set acked_at = now() where id = ${thread.id} and acked_at is null returning id`;
  return acked.length > 0;
}

export interface UnseenReply {
  fromWa: string;
  contactName: string | null;
  body: string;
  createdAt: Date;
}

export async function takeUnseenReplies(ownerId: string): Promise<UnseenReply[]> {
  return sql<UnseenReply[]>`
    with taken as (
      update relay_replies set seen_at = now()
      where owner_id = ${ownerId} and seen_at is null
      returning id, relay_id, from_wa, body, created_at
    )
    select t.from_wa, r.contact_name, t.body, t.created_at
    from taken t join relay_messages r on r.id = t.relay_id
    order by t.id
  `;
}
