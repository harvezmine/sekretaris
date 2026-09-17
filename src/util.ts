export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

const idr = new Intl.NumberFormat("id-ID");

export function formatIdr(amount: number): string {
  return `Rp${idr.format(amount)}`;
}

export function formatDateTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

/** 09.30, as Indonesians write times. */
export function formatClock(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("id-ID", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(date)
    .replace(":", ".");
}

/** Kamis, 17 September */
export function formatDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("id-ID", { timeZone, weekday: "long", day: "numeric", month: "long" }).format(date);
}

export function formatDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("id-ID", { timeZone, day: "numeric", month: "long", year: "numeric" }).format(date);
}

/** ISO 8601 with the zone's numeric offset, e.g. 2026-09-17T10:42:00+07:00. */
export function isoInZone(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const offset = (parts.timeZoneName ?? "GMT").replace("GMT", "") || "+00:00";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

/** Indonesian-first phone normalization to the digits-only international form WhatsApp uses. */
export function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  else if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = `62${digits.slice(1)}`;
  else if (digits.startsWith("8")) digits = `62${digits}`;
  digits = digits.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

export function waMeLink(phone: string, text: string): string {
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
