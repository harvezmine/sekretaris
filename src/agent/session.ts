import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { sql, type UserRow } from "../db/index.js";
import { buildSnapshot } from "./prompt.js";

type MessageParam = Anthropic.Beta.BetaMessageParam;

export interface SessionRow {
  id: string;
  userId: string;
  model: string;
  snapshot: string;
  turns: number;
  lastActiveAt: Date;
  closedAt: Date | null;
}

/**
 * A session is an append-only transcript. It rolls over after a long idle gap (the 1-hour prompt cache is cold by
 * then anyway) or after enough turns that resending the history costs more than starting fresh.
 */
export async function openSession(user: UserRow, model: string): Promise<SessionRow> {
  const [latest] = await sql<SessionRow[]>`
    select * from sessions where user_id = ${user.id} order by id desc limit 1
  `;
  const idleMs = config.MILO_SESSION_IDLE_HOURS * 3_600_000;
  if (
    latest &&
    !latest.closedAt &&
    latest.model === model &&
    Date.now() - latest.lastActiveAt.getTime() < idleMs &&
    latest.turns < config.MILO_SESSION_MAX_TURNS
  ) {
    return latest;
  }
  const snapshot = await buildSnapshot(user);
  const [created] = await sql<SessionRow[]>`
    insert into sessions (user_id, model, snapshot) values (${user.id}, ${model}, ${snapshot}) returning *
  `;
  return created!;
}

export async function loadTranscript(sessionId: string): Promise<MessageParam[]> {
  const rows = await sql<{ role: "user" | "assistant"; content: string }[]>`
    select role, content::text as content from transcript where session_id = ${sessionId} order by id
  `;
  return rows.map((r) => ({ role: r.role, content: JSON.parse(r.content) as MessageParam["content"] }));
}

/**
 * Stored as text cast to json so Postgres keeps the exact bytes: jsonb (which sql.json() sends) re-sorts object keys,
 * and a replayed tool_use input with reordered keys no longer matches the cached prompt prefix.
 */
export async function appendTranscript(sessionId: string, message: MessageParam): Promise<void> {
  await sql`
    insert into transcript (session_id, role, content)
    values (${sessionId}, ${message.role}, ${JSON.stringify(message.content)}::text::json)
  `;
}

export async function touchSession(sessionId: string): Promise<void> {
  await sql`update sessions set turns = turns + 1, last_active_at = now() where id = ${sessionId}`;
}

/** The next turn starts a new session, so a changed profile (such as the persona) takes effect in the snapshot. */
export async function closeSessions(userId: string): Promise<void> {
  await sql`update sessions set closed_at = now() where user_id = ${userId} and closed_at is null`;
}

/** Appends a user/assistant exchange that happened without the model (e.g. a file saved with no question). */
export async function recordStaticExchange(user: UserRow, model: string, userText: string, assistantText: string): Promise<void> {
  const session = await openSession(user, model);
  await appendTranscript(session.id, { role: "user", content: [{ type: "text", text: userText }] });
  await appendTranscript(session.id, { role: "assistant", content: [{ type: "text", text: assistantText }] });
  await sql`update sessions set last_active_at = now() where id = ${session.id}`;
}
