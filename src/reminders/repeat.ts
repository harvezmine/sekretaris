import { isoInZone } from "../util.js";

/**
 * Recurring reminders, written as the small subset of the iCalendar RRULE the model already knows:
 * FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL, BYDAY, BYMONTHDAY and BYMONTH.
 *
 * Every occurrence keeps the same local wall-clock time, so a 08:00 reminder stays at 08:00 even if the
 * user's zone shifts. Each occurrence is its own row; the next one is scheduled after the current one fires,
 * which keeps today's agenda honest about what already went out.
 */

export type Freq = "daily" | "weekly" | "monthly" | "yearly";

export interface Repeat {
  freq: Freq;
  /** Every N days/weeks/months/years. */
  interval: number;
  /** ISO weekdays 1 (Senin) to 7 (Minggu); weekly only. */
  byDay?: number[];
  /** Day of the month, 1-31; monthly and yearly. A day past the end of a short month falls on its last day. */
  byMonthDay?: number;
  /** Month 1-12; yearly only. */
  byMonth?: number;
}

export class RepeatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepeatError";
  }
}

const DAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
const DAY_NAMES = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"] as const;
const MONTH_NAMES = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"] as const;

/** Plain words the user (or the model) may use instead of a full rule. */
const SHORTHAND: Record<string, Repeat> = {
  daily: { freq: "daily", interval: 1 },
  harian: { freq: "daily", interval: 1 },
  hari: { freq: "daily", interval: 1 },
  weekly: { freq: "weekly", interval: 1 },
  mingguan: { freq: "weekly", interval: 1 },
  minggu: { freq: "weekly", interval: 1 },
  monthly: { freq: "monthly", interval: 1 },
  bulanan: { freq: "monthly", interval: 1 },
  bulan: { freq: "monthly", interval: 1 },
  yearly: { freq: "yearly", interval: 1 },
  annually: { freq: "yearly", interval: 1 },
  tahunan: { freq: "yearly", interval: 1 },
  tahun: { freq: "yearly", interval: 1 },
  weekdays: { freq: "weekly", interval: 1, byDay: [1, 2, 3, 4, 5] },
  workdays: { freq: "weekly", interval: 1, byDay: [1, 2, 3, 4, 5] },
  "hari kerja": { freq: "weekly", interval: 1, byDay: [1, 2, 3, 4, 5] },
};

function intField(raw: string, name: string, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new RepeatError(`${name} harus angka ${min}-${max}, bukan "${raw}".`);
  return n;
}

/** Accepts "FREQ=WEEKLY;BYDAY=MO,TH", "daily", "hari kerja"; UNTIL inside the rule is returned separately. */
export function parseRepeat(raw: string): { rule: Repeat; until?: Date } {
  const text = raw.trim();
  if (!text) throw new RepeatError("Aturan pengulangan kosong.");
  const short = SHORTHAND[text.toLowerCase()];
  if (short) return { rule: { ...short } };
  if (!text.includes("=")) throw new RepeatError(`Pengulangan "${raw}" tidak dikenal. Pakai RRULE, mis. FREQ=WEEKLY;BYDAY=MO,TH.`);

  const fields = new Map<string, string>();
  for (const part of text.replace(/^RRULE:/i, "").split(";")) {
    if (!part.trim()) continue;
    const [key, ...rest] = part.split("=");
    fields.set(key!.trim().toUpperCase(), rest.join("=").trim());
  }
  if (fields.has("COUNT")) throw new RepeatError("COUNT belum didukung; pakai batas tanggal (until) kalau pengulangannya harus berhenti.");

  const freqRaw = (fields.get("FREQ") ?? "").toUpperCase();
  const freq = (["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const).find((f) => f === freqRaw);
  if (!freq) throw new RepeatError(`FREQ harus DAILY, WEEKLY, MONTHLY atau YEARLY, bukan "${fields.get("FREQ") ?? ""}".`);

  const rule: Repeat = { freq: freq.toLowerCase() as Freq, interval: fields.has("INTERVAL") ? intField(fields.get("INTERVAL")!, "INTERVAL", 1, 99) : 1 };

  const byDay = fields.get("BYDAY");
  if (byDay) {
    if (rule.freq !== "weekly") throw new RepeatError("BYDAY hanya untuk FREQ=WEEKLY.");
    const days = [
      ...new Set(
        byDay.split(",").map((code) => {
          const i = DAY_CODES.indexOf(code.trim().toUpperCase().slice(-2) as (typeof DAY_CODES)[number]);
          if (i < 0) throw new RepeatError(`Hari "${code}" tidak dikenal; pakai MO, TU, WE, TH, FR, SA atau SU.`);
          return i + 1;
        }),
      ),
    ].sort((a, b) => a - b);
    rule.byDay = days;
  }

  const byMonthDay = fields.get("BYMONTHDAY");
  if (byMonthDay) {
    if (rule.freq !== "monthly" && rule.freq !== "yearly") throw new RepeatError("BYMONTHDAY hanya untuk FREQ=MONTHLY atau YEARLY.");
    rule.byMonthDay = intField(byMonthDay, "BYMONTHDAY", 1, 31);
  }

  const byMonth = fields.get("BYMONTH");
  if (byMonth) {
    if (rule.freq !== "yearly") throw new RepeatError("BYMONTH hanya untuk FREQ=YEARLY.");
    rule.byMonth = intField(byMonth, "BYMONTH", 1, 12);
  }

  const untilRaw = fields.get("UNTIL");
  if (!untilRaw) return { rule };
  const iso = /^\d{8}T\d{6}Z?$/.test(untilRaw)
    ? `${untilRaw.slice(0, 4)}-${untilRaw.slice(4, 6)}-${untilRaw.slice(6, 8)}T${untilRaw.slice(9, 11)}:${untilRaw.slice(11, 13)}:${untilRaw.slice(13, 15)}Z`
    : untilRaw;
  const until = new Date(iso);
  if (Number.isNaN(until.getTime())) throw new RepeatError(`UNTIL "${untilRaw}" tidak bisa dibaca.`);
  return { rule, until };
}

/** The stored form: normalized, so the same rule always reads the same way. */
export function toRule(rule: Repeat): string {
  const parts = [`FREQ=${rule.freq.toUpperCase()}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay?.length) parts.push(`BYDAY=${rule.byDay.map((d) => DAY_CODES[d - 1]).join(",")}`);
  if (rule.byMonth) parts.push(`BYMONTH=${rule.byMonth}`);
  if (rule.byMonthDay) parts.push(`BYMONTHDAY=${rule.byMonthDay}`);
  return parts.join(";");
}

function joinId(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} & ${items.at(-1)}`;
}

/** How the reminder is described back to the user: "setiap Senin & Kamis", "setiap tanggal 25". */
export function formatRepeat(rule: Repeat, anchor?: Date, timeZone?: string): string {
  const every = (unit: string) => (rule.interval === 1 ? `setiap ${unit}` : `setiap ${rule.interval} ${unit}`);
  const local = anchor && timeZone ? isoInZone(anchor, timeZone) : undefined;
  switch (rule.freq) {
    case "daily":
      return rule.interval === 1 ? "setiap hari" : `setiap ${rule.interval} hari`;
    case "weekly": {
      const days = rule.byDay?.length ? rule.byDay : local ? [isoWeekday(local.slice(0, 10))] : [];
      const named = joinId(days.map((d) => DAY_NAMES[d - 1]!));
      if (!named) return every("minggu");
      const weekdays = days.length === 5 && days.every((d) => d <= 5);
      const label = weekdays ? "hari kerja (Senin–Jumat)" : named;
      return rule.interval === 1 ? `setiap ${label}` : `${every("minggu")} pada ${label}`;
    }
    case "monthly": {
      const day = rule.byMonthDay ?? (local ? Number(local.slice(8, 10)) : 0);
      const on = day ? ` tanggal ${day}` : "";
      return rule.interval === 1 ? `setiap bulan${on}` : `${every("bulan")}${on}`;
    }
    case "yearly": {
      const month = rule.byMonth ?? (local ? Number(local.slice(5, 7)) : 0);
      const day = rule.byMonthDay ?? (local ? Number(local.slice(8, 10)) : 0);
      const on = day && month ? ` ${day} ${MONTH_NAMES[month - 1]}` : "";
      return rule.interval === 1 ? `setiap tahun${on}` : `${every("tahun")}${on}`;
    }
  }
}

/* Civil dates: plain YYYY-MM-DD arithmetic, kept away from time zones on purpose. */

function civil(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function addCivilDays(date: string, days: number): string {
  return new Date(civil(date).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

function civilDays(date: string): number {
  return Math.round(civil(date).getTime() / 86_400_000);
}

/** 1 = Senin … 7 = Minggu. */
export function isoWeekday(date: string): number {
  return ((civil(date).getUTCDay() + 6) % 7) + 1;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Month may run past 12 and the day past the month's end; both are normalized, the day by clamping. */
function civilFromParts(year: number, month: number, day: number): string {
  const y = year + Math.floor((month - 1) / 12);
  const m = ((((month - 1) % 12) + 12) % 12) + 1;
  const d = Math.min(day, daysInMonth(y, m));
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The instant of a local wall-clock time; two passes settle the zone's offset at that very moment. */
export function zonedTime(date: string, clock: string, timeZone: string): Date {
  const naive = Date.parse(`${date}T${clock}:00Z`);
  let ts = naive;
  for (let i = 0; i < 2; i++) ts = naive - offsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

function offsetMs(at: Date, timeZone: string): number {
  const offset = isoInZone(at, timeZone).slice(19) || "+00:00";
  const [h, m] = offset.slice(1).split(":").map(Number);
  return (offset.startsWith("-") ? -1 : 1) * ((h ?? 0) * 60 + (m ?? 0)) * 60_000;
}

/** Does the rule itself land on this date? Used to decide whether the first occurrence needs moving. */
export function matchesRule(rule: Repeat, date: string): boolean {
  switch (rule.freq) {
    case "daily":
      return true;
    case "weekly":
      return !rule.byDay?.length || rule.byDay.includes(isoWeekday(date));
    case "monthly":
    case "yearly": {
      const [year, month, day] = date.split("-").map(Number) as [number, number, number];
      if (rule.freq === "yearly" && rule.byMonth && rule.byMonth !== month) return false;
      if (!rule.byMonthDay) return true;
      return day === Math.min(rule.byMonthDay, daysInMonth(year, month));
    }
  }
}

/** Candidate local dates after `start`, in order. Capped so a long gap cannot spin forever. */
function* candidates(rule: Repeat, start: string): Generator<string> {
  switch (rule.freq) {
    case "daily":
      for (let k = 1; k <= 800; k++) yield addCivilDays(start, k * rule.interval);
      return;
    case "weekly": {
      const days = rule.byDay?.length ? rule.byDay : [isoWeekday(start)];
      const weekStart = addCivilDays(start, -(isoWeekday(start) - 1));
      for (let k = 1; k <= 800; k++) {
        const date = addCivilDays(start, k);
        const weeks = Math.floor((civilDays(date) - civilDays(weekStart)) / 7);
        if (weeks % rule.interval === 0 && days.includes(isoWeekday(date))) yield date;
      }
      return;
    }
    case "monthly": {
      const [year, month, day] = start.split("-").map(Number) as [number, number, number];
      // k = 0 is this same month: a rule asking for the 25th, set up on the 16th, should not wait a month.
      for (let k = 0; k <= 240; k++) yield civilFromParts(year, month + k * rule.interval, rule.byMonthDay ?? day);
      return;
    }
    case "yearly": {
      const [year, month, day] = start.split("-").map(Number) as [number, number, number];
      for (let k = 0; k <= 50; k++) yield civilFromParts(year + k * rule.interval, rule.byMonth ?? month, rule.byMonthDay ?? day);
      return;
    }
  }
}

/**
 * The first occurrence strictly after `after`, keeping the local time of day of `anchor`.
 * Returns undefined when the rule runs past its horizon — a gap of years, or a rule that never lands again.
 */
export function nextFire(rule: Repeat, anchor: Date, timeZone: string, after: Date): Date | undefined {
  const local = isoInZone(anchor, timeZone);
  const clock = local.slice(11, 16);
  for (const date of candidates(rule, local.slice(0, 10))) {
    const at = zonedTime(date, clock, timeZone);
    if (at.getTime() > after.getTime()) return at;
  }
  return undefined;
}

/**
 * Where the series should actually start. "Setiap Senin jam 8" asked for on a Rabu keeps the 08:00 but moves
 * to Senin; a time that already fits the rule is left alone.
 */
export function alignFirst(rule: Repeat, wanted: Date, timeZone: string): Date | undefined {
  const date = isoInZone(wanted, timeZone).slice(0, 10);
  return matchesRule(rule, date) ? wanted : nextFire(rule, wanted, timeZone, wanted);
}
