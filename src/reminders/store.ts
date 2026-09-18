import { sql, type UserRow } from "../db/index.js";
import { formatRepeat, nextFire, parseRepeat, toRule, type Repeat } from "./repeat.js";

/** Reading and writing reminders, including the chain that keeps a recurring one going. */

export interface ReminderRow {
  id: string;
  userId: string;
  kind: "user" | "trial_nudge";
  text: string;
  fireAt: Date;
  repeat: string | null;
  repeatUntil: Date | null;
  seriesId: string | null;
}

export interface NewReminder {
  text: string;
  fireAt: Date;
  rule?: Repeat;
  until?: Date;
}

export async function createReminder(user: UserRow, r: NewReminder): Promise<{ id: string; label: string }> {
  const rule = r.rule ? toRule(r.rule) : null;
  const [row] = await sql<{ id: string }[]>`
    insert into reminders (user_id, kind, text, fire_at, repeat, repeat_until)
    values (${user.id}, 'user', ${r.text}, ${r.fireAt}, ${rule}, ${r.until ?? null})
    returning id
  `;
  const id = row!.id;
  if (rule) await sql`update reminders set series_id = ${id} where id = ${id}`;
  return { id, label: r.rule ? formatRepeat(r.rule, r.fireAt, user.timezone) : "" };
}

export async function listReminders(user: UserRow, limit = 20): Promise<ReminderRow[]> {
  return sql<ReminderRow[]>`
    select id, user_id, kind, text, fire_at, repeat, repeat_until, series_id from reminders
    where user_id = ${user.id} and status = 'scheduled' and kind = 'user'
    order by fire_at limit ${limit}
  `;
}

/** Cancelling one occurrence of a recurring reminder stops the whole series: that is what "stop" means here. */
export async function cancelReminder(user: UserRow, id: number): Promise<{ cancelled: boolean; repeat: string | null }> {
  const [row] = await sql<{ id: string; repeat: string | null; seriesId: string | null }[]>`
    select id, repeat, series_id from reminders
    where id = ${id} and user_id = ${user.id} and status = 'scheduled' and kind = 'user'
  `;
  if (!row) return { cancelled: false, repeat: null };
  const series = row.seriesId ?? row.id;
  await sql`
    update reminders set status = 'cancelled'
    where user_id = ${user.id} and kind = 'user' and status = 'scheduled'
      and (id = ${row.id} or (series_id is not null and series_id = ${series}))
  `;
  return { cancelled: true, repeat: row.repeat };
}

/**
 * Queues the occurrence that follows the one just delivered. Called after every attempt, so one failed send
 * (the 24-hour window, a channel hiccup) does not end a daily reminder. Occurrences missed while the app was
 * down are skipped rather than fired late in a burst.
 */
export async function scheduleNext(row: ReminderRow, user: UserRow, now = new Date()): Promise<Date | undefined> {
  if (row.kind !== "user" || !row.repeat) return undefined;
  const { rule } = parseRepeat(row.repeat);
  const after = new Date(Math.max(now.getTime(), row.fireAt.getTime()));
  const next = nextFire(rule, row.fireAt, user.timezone, after);
  if (!next) return undefined;
  if (row.repeatUntil && next.getTime() > row.repeatUntil.getTime()) return undefined;

  const series = row.seriesId ?? row.id;
  const [existing] = await sql<{ id: string }[]>`
    select id from reminders where series_id = ${series} and status = 'scheduled' and id <> ${row.id} limit 1
  `;
  if (existing) return undefined;
  await sql`
    insert into reminders (user_id, kind, text, fire_at, repeat, repeat_until, series_id)
    values (${row.userId}, 'user', ${row.text}, ${next}, ${row.repeat}, ${row.repeatUntil}, ${series})
  `;
  return next;
}
