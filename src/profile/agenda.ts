import { sql, type UserRow } from "../db/index.js";
import { DEFAULT_ASSISTANT_NAME } from "../persona/catalog.js";
import { eventLine, listEvents, type CalendarEvent } from "../google/calendar.js";
import { accountName, googleEnabled, GoogleAuthError, listAccounts, SCOPE, withAccount, type GoogleAccount } from "../google/client.js";
import { searchMail, senderName } from "../google/gmail.js";
import { tasksDueToday, type Task } from "../google/tasks.js";
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
  repeat: string | null;
}

export async function agendaFor(user: UserRow, plusDays = 0, now = new Date()): Promise<AgendaItem[]> {
  const { start, end } = dayBounds(user.timezone, now, plusDays);
  return sql<AgendaItem[]>`
    select fire_at, text, status, repeat from reminders
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
      line: `• ${icons ? "⏰ " : ""}${timeFmt(i.fireAt, timeZone)} ${i.text}${i.repeat ? " 🔁" : ""}${done ? " _(sudah lewat)_" : ""}`,
    };
  });
}

function eventEntries(events: CalendarEvent[], timeZone: string, now: Date): Entry[] {
  return events.map((e) => {
    const notes = [e.account ?? "", !e.allDay && e.end.getTime() <= now.getTime() ? "sudah lewat" : ""].filter(Boolean);
    return {
      at: e.start,
      sort: e.allDay ? e.start.getTime() - 1 : e.start.getTime(),
      line: `• 📅 ${eventLine(e, timeZone)}${notes.length ? ` _(${notes.join(", ")})_` : ""}`,
    };
  });
}

export interface CalendarRead {
  today: CalendarEvent[];
  tomorrow: CalendarEvent[];
  note?: string;
}

/**
 * A user may keep both a personal and a work Google account. Reading is the forgiving half of that: a day is only
 * whole when every calendar is in it, so each read below asks every connected account and says which one an item
 * came from. Writing is the careful half and lives in runTool, which never picks an account on the user's behalf.
 */
async function readableAccounts(userId: string, scope: string): Promise<GoogleAccount[]> {
  if (!googleEnabled()) return [];
  return (await listAccounts(userId)).filter((a) => a.scopes.includes(scope));
}

const byStart = (a: CalendarEvent, b: CalendarEvent) => a.start.getTime() - b.start.getTime();

/** One account failing should not read as the whole calendar being gone, so the warning names it when there are several. */
function calendarNote(expired: string[], broken: string[]): string | undefined {
  const which = (names: string[]) => (names.some(Boolean) ? ` akun ${names.join(" dan ")}` : "");
  if (expired.length) return `⚠️ Google Kalender${which(expired)} tidak bisa dibaca karena login kedaluwarsa. Ketik *KONEKSI* untuk login ulang.`;
  if (broken.length) return `⚠️ Google Kalender${which(broken)} sedang tidak bisa dibaca.`;
  return undefined;
}

/** Undefined when the user has no calendar connected; a note when one is connected but unreadable. */
export async function calendarDays(user: UserRow, now: Date): Promise<CalendarRead | undefined> {
  const accounts = await readableAccounts(user.id, SCOPE.calendar);
  if (!accounts.length) return undefined;
  const today = dayBounds(user.timezone, now, 0);
  const tomorrow = dayBounds(user.timezone, now, 1);
  const many = accounts.length > 1;
  const events: CalendarEvent[] = [];
  const expired: string[] = [];
  const broken: string[] = [];

  await Promise.all(
    accounts.map(async (account) => {
      // With one account the name is noise; with two it is the whole point of the line.
      const tag = many ? accountName(account) : "";
      if (account.status !== "active") {
        expired.push(tag);
        return;
      }
      try {
        const found = await withAccount(account.email, () => listEvents(user.id, user.timezone, { from: today.start, to: tomorrow.end }));
        events.push(...(tag ? found.map((e) => ({ ...e, account: tag })) : found));
      } catch (err) {
        (err instanceof GoogleAuthError ? expired : broken).push(tag);
      }
    }),
  );

  const note = calendarNote(expired, broken);
  return {
    today: events.filter((e) => e.start < today.end && e.end > today.start).sort(byStart),
    tomorrow: events.filter((e) => e.start >= tomorrow.start).sort(byStart),
    ...(note ? { note } : {}),
  };
}

/** Tasks the user keeps in Google Tasks: no hour of their own, so they sit above the timed agenda. */
export async function dueTasks(user: UserRow, now = new Date()): Promise<Task[]> {
  const accounts = (await readableAccounts(user.id, SCOPE.tasks)).filter((a) => a.status === "active");
  const many = accounts.length > 1;
  const found = await Promise.all(
    accounts.map(async (account) => {
      try {
        const tasks = await withAccount(account.email, () => tasksDueToday(user.id, user.timezone, now));
        return many ? tasks.map((t) => ({ ...t, account: accountName(account) })) : tasks;
      } catch {
        return [];
      }
    }),
  );
  return found.flat();
}

export function taskLines(tasks: Task[], today: string): string[] {
  return tasks.map((t) => {
    const notes = [t.account ?? "", t.due && t.due < today ? "lewat tenggat" : ""].filter(Boolean);
    return `• ✅ ${t.title}${notes.length ? ` _(${notes.join(", ")})_` : ""}`;
  });
}

export async function agendaText(user: UserRow, now = new Date()): Promise<string> {
  const [today, tomorrow, calendar, tasks] = await Promise.all([
    agendaFor(user, 0, now),
    agendaFor(user, 1, now),
    calendarDays(user, now),
    dueTasks(user, now),
  ]);
  const icons = Boolean(calendar);
  const entries = [...reminderEntries(today, user.timezone, now, icons), ...eventEntries(calendar?.today ?? [], user.timezone, now)].sort(
    (a, b) => a.sort - b.sort,
  );
  const lines = [`📅 *Agenda hari ini*, ${dayFmt(now, user.timezone)}`];
  lines.push(
    ...(entries.length || tasks.length ? entries.map((e) => e.line) : ["Belum ada agenda untuk hari ini."]),
    ...taskLines(tasks, localNow(user.timezone, now).date),
  );
  if (calendar?.note) lines.push(calendar.note);
  const next = [
    ...tomorrow.map((r) => ({ at: r.fireAt, text: `${timeFmt(r.fireAt, user.timezone)} ${r.text}` })),
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

export async function importantMail(user: UserRow): Promise<string[]> {
  const accounts = (await readableAccounts(user.id, SCOPE.gmailRead)).filter((a) => a.status === "active");
  if (!accounts.length) return [];
  const many = accounts.length > 1;
  const found = await Promise.all(
    accounts.map(async (account) => {
      try {
        const mails = await withAccount(account.email, () => searchMail(user.id, "is:unread is:important newer_than:1d", 3));
        return mails.map((mail) => ({ mail, tag: many ? accountName(account) : "" }));
      } catch {
        return [];
      }
    }),
  );
  // Newest first, because two inboxes merged in connection order read as an arbitrary pile.
  const mails = found
    .flat()
    .sort((a, b) => (b.mail.date?.getTime() ?? 0) - (a.mail.date?.getTime() ?? 0))
    .slice(0, 4);
  if (!mails.length) return [];
  return [
    "",
    `📧 *Email penting belum dibaca* (${mails.length}):`,
    ...mails.map(({ mail, tag }) => `• ${senderName(mail.from)}: ${mail.subject}${tag ? ` _(${tag})_` : ""}`),
  ];
}

export async function briefingText(user: UserRow, now = new Date()): Promise<string> {
  const [today, calendar, mail, tasks] = await Promise.all([
    agendaFor(user, 0, now),
    calendarDays(user, now),
    importantMail(user),
    dueTasks(user, now),
  ]);
  const upcoming = [
    ...reminderEntries(today.filter((i) => i.fireAt.getTime() > now.getTime()), user.timezone, now, Boolean(calendar)),
    ...eventEntries((calendar?.today ?? []).filter((e) => e.allDay || e.end.getTime() > now.getTime()), user.timezone, now),
  ].sort((a, b) => a.sort - b.sort);
  const who = user.profile?.callName ?? user.displayName ?? "";
  return [
    `☀️ Selamat pagi${who ? `, ${who}` : ""}!`,
    "",
    upcoming.length || tasks.length
      ? `*Agenda hari ini* (${upcoming.length + tasks.length}):`
      : "Hari ini belum ada agenda. Kalau ada janji atau tenggat, kabari saya supaya saya ingatkan.",
    ...upcoming.map((e) => e.line),
    ...taskLines(tasks, localNow(user.timezone, now).date),
    ...(calendar?.note ? [calendar.note] : []),
    ...mail,
    "",
    `Ketik *MENU* kalau mau lihat pilihan cepat.`,
  ].join("\n");
}
