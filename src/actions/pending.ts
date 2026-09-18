import { sql } from "../db/index.js";
import type { Button } from "../wa/client.js";

/**
 * Actions the model may prepare but never perform: they wait for the user to tap a button, which the pipeline
 * handles without the model. One pending action per user; a newer one replaces the older.
 */

export const ACTION_MINUTES = 15;

export type ActionKind = "gmail_send" | "calendar_invite" | "calendar_delete" | "server_run";

export interface PendingAction<P = Record<string, unknown>> {
  id: string;
  userId: string;
  kind: ActionKind;
  payload: P;
  status: "pending" | "running" | "done" | "failed" | "cancelled" | "superseded";
  result: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export async function createAction(userId: string, kind: ActionKind, payload: object): Promise<PendingAction> {
  await sql`update pending_actions set status = 'superseded' where user_id = ${userId} and status = 'pending'`;
  const [row] = await sql<PendingAction[]>`
    insert into pending_actions (user_id, kind, payload, expires_at)
    values (${userId}, ${kind}, ${sql.json(payload as never)}, now() + ${`${ACTION_MINUTES} minutes`}::interval)
    returning *
  `;
  return row!;
}

/** Taken before a model turn; actions with a higher id were prepared during that turn. */
export async function lastActionId(userId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`select coalesce(max(id), 0)::text as id from pending_actions where user_id = ${userId}`;
  return row?.id ?? "0";
}

export async function pendingActionAfter(userId: string, afterId: string): Promise<PendingAction | undefined> {
  const [row] = await sql<PendingAction[]>`
    select * from pending_actions
    where user_id = ${userId} and status = 'pending' and id > ${afterId} and expires_at > now()
    order by id desc limit 1
  `;
  return row;
}

export async function claimAction(userId: string, id: string): Promise<PendingAction | undefined> {
  const [row] = await sql<PendingAction[]>`
    update pending_actions set status = 'running'
    where id = ${id} and user_id = ${userId} and status = 'pending' and expires_at > now()
    returning *
  `;
  return row;
}

export async function getAction(userId: string, id: string): Promise<PendingAction | undefined> {
  const [row] = await sql<PendingAction[]>`select * from pending_actions where id = ${id} and user_id = ${userId}`;
  return row;
}

export async function finishAction(id: string, status: "done" | "failed", result: string): Promise<void> {
  await sql`update pending_actions set status = ${status}, result = ${result.slice(0, 1000)} where id = ${id}`;
}

export async function cancelAction(userId: string, id: string): Promise<PendingAction | undefined> {
  const [row] = await sql<PendingAction[]>`
    update pending_actions set status = 'cancelled' where id = ${id} and user_id = ${userId} and status = 'pending' returning *
  `;
  return row;
}

const YES_LABEL: Record<ActionKind, string> = {
  gmail_send: "Kirim",
  calendar_invite: "Kirim undangan",
  calendar_delete: "Hapus",
  server_run: "Jalankan",
};

export function actionButtons(action: Pick<PendingAction, "id" | "kind">): Button[] {
  const yes = YES_LABEL[action.kind] ?? "Kirim";
  return [
    { id: `act_yes:${action.id}`, title: yes },
    { id: `act_no:${action.id}`, title: "Batal" },
  ];
}
