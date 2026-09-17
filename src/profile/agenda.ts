import { sql, type UserRow } from "../db/index.js";
import { DEFAULT_ASSISTANT_NAME } from "../persona/catalog.js";
import { eventLine, listEvents, type CalendarEvent } from "../google/calendar.js";
import { getAccount, googleEnabled, GoogleAuthError, SCOPE } from "../google/client.js";
import { searchMail, senderName } from "../google/gmail.js";
import { formatClock, formatDay, isoInZone } from "../util.js";

/** The user's local calendar day and clock, derived from their time zone. */
export function localNow(timeZone: string, now = new Date()): { date: string; clock: string; offset: string } {
  const iso = isoInZone(now, timeZone);
  return { date: iso.slice(0, 10), clock: iso.slice(11, 16), offset: iso.slice(19) || "+00:00" };
}

function dayBounds(timeZone: string, now = new Date(), plusDays = 0): { start: Date; end: Date } {
  const { date, offset } = localNow(timeZone, now);
  const start = new Date(new Date(`${date}T00:00:00${offset}`).getTime() + plusDays * 86_400_000);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

export interface AgendaItem {
  fireAt: Date;
  text: string;
  status: string;
}

export async function agendaFor(user: UserRow, plusDays = 0, now = new Date()): Promise<AgendaItem[]> {
  const { start, end } = dayBounds(user.timezone, now, plusDays);
  return sql<AgendaItem[]>`
    select fire_at, text, status from reminders
    where user_id = ${user.id} and kind = 'user' and status in ('scheduled', 'sending', 'sent')
      and fire_at >= ${start} and fire_at < ${end}
    order by fire_at
    limit 30
  `;
}

const timeFmt = formatClock;
const dayFmt = formatDay;

interface Entry {
  at: Date;
  sort: number;
  line: string;
}

function reminderEntries(items: AgendaItem[], timeZone: string, now: Date, icons: boolean): Entry[] {
  return items.map((i) => {
    const done = i.status === "sent" || i.fireAt.getTime() <= now.getTime();
    return {
      at: i.fireAt,
      sort: i.fireAt.getTime(),
      line: `• ${icons ? "⏰ " : ""}${timeFmt(i.fireAt, timeZone)} — ${i.text}${done ? " _(sudah lewat)_" : ""}`,
    };
  });
}

function eventEntries(events: CalendarEvent[], timeZone: string, now: Date): Entry[] {
  return events.map((e) => ({
    at: e.start,
    sort: e.allDay ? e.start.getTime() - 1 : e.start.getTime(),
    line: `• 📅 ${eventLine(e, timeZone)}${!e.allDay && e.end.getTime() <= now.getTime() ? " _(sudah lewat)_" : ""}`,
  }));
}

interface CalendarRead {
  today: CalendarEvent[];
  tomorrow: CalendarEvent[];
  note?: string;
}

/** Undefined when the user has no calendar connected; a note when it is connected but unreadable. */
async function calendarDays(user: UserRow, now: Date): Promise<CalendarRead | undefined> {
  if (!googleEnabled()) return undefined;
  const account = await getAccount(user.id);
  if (!account?.scopes.includes(SCOPE.calendar)) return undefined;
  const expired = { today: [], tomorrow: [], note: "⚠️ Google Kalender tidak bisa dibaca karena login kedaluwarsa. Ketik *KONEKSI* untuk login ulang." };
  if (account.status !== "active") return expired;
  const today = dayBounds(user.timezone, now, 0);
  const tomorrow = dayBounds(user.timezone, now, 1);
  try {
    const events = await listEvents(user.id, user.timezone, { from: today.start, to: tomorrow.end });
    return {
      today: events.filter((e) => e.start < today.end && e.end > today.start),
      tomorrow: events.filter((e) => e.start >= tomorrow.start),
    };
  } catch (err) {
    if (err instanceof GoogleAuthError) return expired;
    return { today: [], tomorrow: [], note: "⚠️ Google Kalender sedang tidak bisa dibaca." };
  }
}

export async function agendaText(user: UserRow, now = new Date()): Promise<string> {
  const [today, tomorrow, calendar] = await Promise.all([agendaFor(user, 0, now), agendaFor(user, 1, now), calendarDays(user, now)]);
  const icons = Boolean(calendar);
  const entries = [...reminderEntries(today, user.timezone, now, icons), ...eventEntries(calendar?.today ?? [], user.timezone, now)].sort(
    (a, b) => a.sort - b.sort,
  );
  const lines = [`📅 *Agenda hari ini* — ${dayFmt(now, user.timezone)}`];
  lines.push(...(entries.length ? entries.map((e) => e.line) : ["Belum ada agenda untuk hari ini."]));
  if (calendar?.note) lines.push(calendar.note);
  const next = [
    ...tomorrow.map((r) => ({ at: r.fireAt, text: `${timeFmt(r.fireAt, user.timezone)} — ${r.text}` })),
    ...(calendar?.tomorrow ?? []).map((e) => ({ at: e.start, text: eventLine(e, user.timezone) })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  if (next.length) lines.push("", `*Besok:* ${next.length} agenda, pertama ${calendar ? "" : "jam "}${next[0]!.text}`);
  lines.push(
    "",
    calendar
      ? "_Dari Google Kalender dan pengingat Anda._"
      : `_Agenda diambil dari pengingat yang Anda buat di sini._ Tambah dengan, misalnya: _ingetin jam 3 rapat vendor_.${googleEnabled() ? " Hubungkan Google Kalender lewat *KONEKSI*." : ""}`,
  );
  return lines.join("\n");
}

async function importantMail(user: UserRow): Promise<string[]> {
  if (!googleEnabled()) return [];
  const account = await getAccount(user.id);
  if (account?.status !== "active" || !account.scopes.includes(SCOPE.gmailRead)) return [];
  try {
    const mails = await searchMail(user.id, "is:unread is:important newer_than:1d", 3);
    if (!mails.length) return [];
    return ["", `📧 *Email penting belum dibaca* (${mails.length}):`, ...mails.map((m) => `• ${senderName(m.from)} — ${m.subject}`)];
  } catch {
    return [];
  }
}

export async function briefingText(user: UserRow, now = new Date()): Promise<string> {
  const [today, calendar, mail] = await Promise.all([agendaFor(user, 0, now), calendarDays(user, now), importantMail(user)]);
  const upcoming = [
    ...reminderEntries(today.filter((i) => i.fireAt.getTime() > now.getTime()), user.timezone, now, Boolean(calendar)),
    ...eventEntries((calendar?.today ?? []).filter((e) => e.allDay || e.end.getTime() > now.getTime()), user.timezone, now),
  ].sort((a, b) => a.sort - b.sort);
  const who = user.profile?.callName ?? user.displayName ?? "";
  return [
    `☀️ Selamat pagi${who ? `, ${who}` : ""}!`,
    "",
    upcoming.length ? `*Agenda hari ini* (${upcoming.length}):` : "Hari ini belum ada agenda. Kalau ada janji atau tenggat, kabari saya supaya saya ingatkan.",
    ...upcoming.map((e) => e.line),
    ...(calendar?.note ? [calendar.note] : []),
    ...mail,
    "",
    `Ketik *MENU* untuk pilihan cepat. — ${user.assistantName ?? DEFAULT_ASSISTANT_NAME}`,
  ].join("\n");
}
