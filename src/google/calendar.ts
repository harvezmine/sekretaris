import { randomUUID } from "node:crypto";
import { formatClock, formatDay, isoInZone } from "../util.js";
import { callGoogle, ENDPOINTS, SCOPE } from "./client.js";

export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location?: string;
  attendees: string[];
  meetLink?: string;
  link?: string;
}

interface ApiTime {
  dateTime?: string;
  date?: string;
}

interface ApiEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  start?: ApiTime;
  end?: ApiTime;
  attendees?: { email?: string; displayName?: string; self?: boolean; resource?: boolean }[];
  hangoutLink?: string;
  htmlLink?: string;
}

const CAL = `${ENDPOINTS.calendar}/calendars/primary/events`;
const NEED = [SCOPE.calendar];

/** All-day dates carry no zone; they are placed at midnight in the user's zone. */
function toDate(t: ApiTime | undefined, offset: string): Date {
  if (t?.dateTime) return new Date(t.dateTime);
  if (t?.date) return new Date(`${t.date}T00:00:00${offset}`);
  return new Date(Number.NaN);
}

function offsetOf(timeZone: string, at: Date): string {
  return isoInZone(at, timeZone).slice(19) || "+00:00";
}

function toEvent(e: ApiEvent, timeZone: string): CalendarEvent {
  const offset = offsetOf(timeZone, new Date());
  return {
    id: e.id,
    title: e.summary?.trim() || "(tanpa judul)",
    start: toDate(e.start, offset),
    end: toDate(e.end, offset),
    allDay: Boolean(e.start?.date && !e.start.dateTime),
    ...(e.location ? { location: e.location } : {}),
    attendees: (e.attendees ?? []).filter((a) => !a.self && !a.resource && a.email).map((a) => a.displayName ?? a.email!),
    ...(e.hangoutLink ? { meetLink: e.hangoutLink } : {}),
    ...(e.htmlLink ? { link: e.htmlLink } : {}),
  };
}

export async function listEvents(
  userId: string,
  timeZone: string,
  range: { from: Date; to: Date; query?: string | undefined; max?: number | undefined },
): Promise<CalendarEvent[]> {
  const res = await callGoogle<{ items?: ApiEvent[] }>(userId, NEED, {
    url: CAL,
    query: {
      timeMin: range.from.toISOString(),
      timeMax: range.to.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: Math.min(Math.max(range.max ?? 50, 1), 100),
      q: range.query || undefined,
    },
  });
  return (res.items ?? []).filter((e) => e.status !== "cancelled").map((e) => toEvent(e, timeZone));
}

export async function getEvent(userId: string, timeZone: string, eventId: string): Promise<CalendarEvent> {
  const e = await callGoogle<ApiEvent>(userId, NEED, { url: `${CAL}/${encodeURIComponent(eventId)}` });
  return toEvent(e, timeZone);
}

export interface NewEvent {
  title: string;
  start: string;
  end: string;
  location?: string | undefined;
  description?: string | undefined;
  attendees?: string[] | undefined;
  addMeet?: boolean | undefined;
}

export async function createEvent(userId: string, timeZone: string, input: NewEvent): Promise<CalendarEvent> {
  const attendees = input.attendees ?? [];
  const e = await callGoogle<ApiEvent>(userId, NEED, {
    method: "POST",
    url: CAL,
    query: { sendUpdates: attendees.length ? "all" : "none", conferenceDataVersion: input.addMeet ? 1 : 0 },
    json: {
      summary: input.title,
      ...(input.location ? { location: input.location } : {}),
      ...(input.description ? { description: input.description } : {}),
      start: { dateTime: input.start, timeZone },
      end: { dateTime: input.end, timeZone },
      ...(attendees.length ? { attendees: attendees.map((email) => ({ email })) } : {}),
      ...(input.addMeet ? { conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
    },
  });
  return toEvent(e, timeZone);
}

export async function deleteEvent(userId: string, eventId: string, notifyGuests: boolean): Promise<void> {
  await callGoogle<void>(userId, NEED, {
    method: "DELETE",
    url: `${CAL}/${encodeURIComponent(eventId)}`,
    query: { sendUpdates: notifyGuests ? "all" : "none" },
  });
}

export function eventTime(e: Pick<CalendarEvent, "start" | "end" | "allDay">, timeZone: string, withDay = false): string {
  const day = withDay ? `${formatDay(e.start, timeZone)}, ` : "";
  if (e.allDay) return `${day}sepanjang hari`;
  return `${day}${formatClock(e.start, timeZone)}–${formatClock(e.end, timeZone)}`;
}

export function eventLine(e: CalendarEvent, timeZone: string, withDay = false): string {
  const extras = [
    e.location ? `📍 ${e.location}` : "",
    e.meetLink ? "Meet" : "",
    e.attendees.length ? `${e.attendees.length} tamu` : "",
  ].filter(Boolean);
  return `${eventTime(e, timeZone, withDay)} ${e.title}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

export interface Slot {
  start: Date;
  end: Date;
}

/**
 * Free time between `dayStart` and `dayEnd` (HH:MM, local) on each day of the range, around timed events.
 * All-day events do not block time: they are usually reminders or out-of-office markers the user judges themselves.
 */
export function freeSlots(
  events: CalendarEvent[],
  timeZone: string,
  opts: { from: Date; to: Date; minutes: number; dayStart: string; dayEnd: string; max?: number },
): Slot[] {
  const busy = events.filter((e) => !e.allDay).sort((a, b) => a.start.getTime() - b.start.getTime());
  const slots: Slot[] = [];
  const need = opts.minutes * 60_000;
  const firstDay = isoInZone(opts.from, timeZone).slice(0, 10);
  for (let d = 0; d < 31 && slots.length < (opts.max ?? 8); d++) {
    const date = new Date(new Date(`${firstDay}T12:00:00Z`).getTime() + d * 86_400_000).toISOString().slice(0, 10);
    const offset = offsetOf(timeZone, new Date(`${date}T12:00:00Z`));
    const open = new Date(`${date}T${opts.dayStart}:00${offset}`);
    const close = new Date(`${date}T${opts.dayEnd}:00${offset}`);
    if (open >= opts.to) break;
    let cursor = new Date(Math.max(open.getTime(), opts.from.getTime()));
    const end = new Date(Math.min(close.getTime(), opts.to.getTime()));
    for (const e of busy) {
      if (e.end <= cursor || e.start >= end) continue;
      if (e.start.getTime() - cursor.getTime() >= need) slots.push({ start: cursor, end: e.start });
      if (e.end > cursor) cursor = e.end;
    }
    if (end.getTime() - cursor.getTime() >= need) slots.push({ start: cursor, end });
  }
  return slots.slice(0, opts.max ?? 8);
}
