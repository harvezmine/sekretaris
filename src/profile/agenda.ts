import { sql, type UserRow } from "../db/index.js";
import { DEFAULT_ASSISTANT_NAME } from "../persona/catalog.js";
import { isoInZone } from "../util.js";

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

const timeFmt = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat("id-ID", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d).replace(":", ".");

const dayFmt = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat("id-ID", { timeZone, weekday: "long", day: "numeric", month: "long" }).format(d);

function itemLines(items: AgendaItem[], timeZone: string, now: Date): string[] {
  return items.map((i) => {
    const done = i.status === "sent" || i.fireAt.getTime() <= now.getTime();
    return `• ${timeFmt(i.fireAt, timeZone)} — ${i.text}${done ? " _(sudah lewat)_" : ""}`;
  });
}

export async function agendaText(user: UserRow, now = new Date()): Promise<string> {
  const [today, tomorrow] = await Promise.all([agendaFor(user, 0, now), agendaFor(user, 1, now)]);
  const lines = [`📅 *Agenda hari ini* — ${dayFmt(now, user.timezone)}`];
  lines.push(...(today.length ? itemLines(today, user.timezone, now) : ["Belum ada agenda untuk hari ini."]));
  if (tomorrow.length) {
    lines.push("", `*Besok:* ${tomorrow.length} agenda, pertama jam ${timeFmt(tomorrow[0]!.fireAt, user.timezone)} — ${tomorrow[0]!.text}`);
  }
  lines.push("", "_Agenda diambil dari pengingat yang Anda buat di sini._ Tambah dengan, misalnya: _ingetin jam 3 rapat vendor_.");
  return lines.join("\n");
}

export async function briefingText(user: UserRow, now = new Date()): Promise<string> {
  const today = await agendaFor(user, 0, now);
  const upcoming = today.filter((i) => i.fireAt.getTime() > now.getTime());
  const who = user.profile?.callName ?? user.displayName ?? "";
  return [
    `☀️ Selamat pagi${who ? `, ${who}` : ""}!`,
    "",
    upcoming.length ? `*Agenda hari ini* (${upcoming.length}):` : "Hari ini belum ada agenda. Kalau ada janji atau tenggat, kabari saya supaya saya ingatkan.",
    ...itemLines(upcoming, user.timezone, now),
    "",
    `Ketik *MENU* untuk pilihan cepat. — ${user.assistantName ?? DEFAULT_ASSISTANT_NAME}`,
  ].join("\n");
}
