import type Anthropic from "@anthropic-ai/sdk";
import type { Agent } from "../agent/run.js";
import type { UserProfile, UserRow } from "../db/index.js";
import { eventLine } from "../google/calendar.js";
import { DEFAULT_ASSISTANT_NAME, findPersona, personaBlock } from "../persona/catalog.js";
import { agendaFor, calendarDays, importantMail, localNow } from "../profile/agenda.js";
import { formatClock, formatDay } from "../util.js";

/**
 * The secretary's own initiative: a morning check-in with the day's agenda, a nudge to break for lunch, and an
 * end-of-day look at tomorrow. They run without the user setting anything up, keep to working hours, and each can
 * be moved or switched off in plain words.
 *
 * The wording is written fresh each time in the assistant's own voice, so it does not read like a bot sending the
 * same text every day. The facts are not: every time the message mentions must be one that is on the agenda, or
 * the message is replaced by a plain template.
 */

export type RoutineKind = "morning" | "lunch" | "evening";
export const ROUTINE_KINDS: readonly RoutineKind[] = ["morning", "lunch", "evening"];

export const ROUTINE_DEFAULTS: Record<RoutineKind, string> = { morning: "07:30", lunch: "12:00", evening: "17:30" };

/** How late a check-in may still go out, e.g. after the app was down. Later than this it is skipped, not sent. */
const LATE_LIMIT_MIN: Record<RoutineKind, number> = { morning: 180, lunch: 90, evening: 120 };

/** Someone mid-conversation is not interrupted; the check-in waits until they have been quiet this long. */
export const QUIET_BEFORE_MIN = 10;

export const ROUTINE_LABEL: Record<RoutineKind, string> = { morning: "pagi", lunch: "siang", evening: "sore" };

/** HH:MM, or undefined when the user switched it off. The old morning setting still counts. */
export function routineTime(profile: UserProfile | undefined, kind: RoutineKind): string | undefined {
  const set = profile?.routines?.[kind];
  if (set === "off") return undefined;
  if (set) return set;
  if (kind === "morning" && profile?.briefingTime) return profile.briefingTime;
  return ROUTINE_DEFAULTS[kind];
}

/** 1 = Senin … 7 = Minggu, for a YYYY-MM-DD date. */
function isoWeekday(date: string): number {
  return ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

export interface DueRoutine {
  kind: RoutineKind;
  /** Minutes past the set time. */
  late: number;
  /** Past the late limit: claim the day so it cannot go out later, but send nothing. */
  expired: boolean;
  weekend: boolean;
}

/** Which check-ins have reached their time today. Pure: the caller decides about activity and what was sent. */
export function dueRoutines(profile: UserProfile | undefined, timeZone: string, now = new Date()): DueRoutine[] {
  const local = localNow(timeZone, now);
  const weekend = isoWeekday(local.date) >= 6;
  const [nh, nm] = local.clock.split(":").map(Number) as [number, number];
  const out: DueRoutine[] = [];
  for (const kind of ROUTINE_KINDS) {
    const at = routineTime(profile, kind);
    if (!at) continue;
    // A lunch break and an end-of-day wrap-up belong to working days.
    if (weekend && kind !== "morning") continue;
    const [h, m] = at.split(":").map(Number) as [number, number];
    const late = nh * 60 + nm - (h * 60 + m);
    if (late < 0) continue;
    out.push({ kind, late, expired: late > LATE_LIMIT_MIN[kind], weekend });
  }
  return out;
}

export interface RoutineFacts {
  /** Plain lines, "09.00 Presentasi investor", in time order. */
  today: string[];
  tomorrow: string[];
  mail: string[];
  calendarNote?: string;
  /** Every clock time that appears above, to check the written message against. */
  times: Set<string>;
}

const CLOCK = /\b([01]?\d|2[0-3])[.:]([0-5]\d)\b/g;

function clocksIn(text: string): string[] {
  return [...text.matchAll(CLOCK)].map((m) => `${m[1]!.padStart(2, "0")}.${m[2]}`);
}

/** What the check-in may talk about: the user's reminders and, when connected, their calendar and important mail. */
export async function routineFacts(user: UserRow, kind: RoutineKind, now = new Date()): Promise<RoutineFacts> {
  const tz = user.timezone;
  const [today, tomorrow, calendar, mail] = await Promise.all([
    agendaFor(user, 0, now),
    agendaFor(user, 1, now),
    calendarDays(user, now),
    kind === "morning" ? importantMail(user) : Promise.resolve([]),
  ]);
  const upcoming = (items: { fireAt: Date; text: string; status: string }[], from: Date | undefined) =>
    items.filter((i) => i.status !== "cancelled" && (!from || i.fireAt.getTime() > from.getTime()));

  const lines = (reminders: { fireAt: Date; text: string }[], events: NonNullable<typeof calendar>["today"]) =>
    [
      ...reminders.map((r) => ({ at: r.fireAt.getTime(), line: `${formatClock(r.fireAt, tz)} ${r.text}` })),
      ...events.map((e) => ({ at: e.start.getTime(), line: eventLine(e, tz).replace(" — ", " ").replace(/–/g, "-") })),
    ]
      .sort((a, b) => a.at - b.at)
      .map((x) => x.line);

  const todayEvents = (calendar?.today ?? []).filter((e) => e.allDay || e.end.getTime() > now.getTime());
  const todayLines = lines(upcoming(today, now), todayEvents);
  const tomorrowLines = lines(upcoming(tomorrow, undefined), calendar?.tomorrow ?? []);
  const mailLines = mail.filter((l) => l.startsWith("• ")).map((l) => l.slice(2).replace(" — ", ": "));
  const times = new Set([...todayLines, ...tomorrowLines].flatMap(clocksIn));
  return {
    today: todayLines,
    tomorrow: tomorrowLines,
    mail: mailLines,
    ...(calendar?.note ? { calendarNote: calendar.note.replace(/[*_]/g, "") } : {}),
    times,
  };
}

const TASK: Record<RoutineKind, string> = {
  morning: [
    "This is the morning check-in. Greet them for the morning, by the name in the profile if there is one.",
    "If there is anything on today's agenda, tell them what it is: times first, briefly, as a short list only if there are three or more items.",
    "Then ask, the way a person would, whether there is anything else planned today that you should note or remind them of.",
    "If the agenda is empty, say the day looks free so far and ask what they have planned, so you can help keep track of it.",
    "If there is important unread mail, mention it in one short sentence at the end.",
  ].join(" "),
  lunch: [
    "This is the lunchtime nudge: remind them, kindly and briefly, to take a break and have lunch.",
    "If something on today's agenda is coming up soon, mention it so they can time the break.",
    "No health lecture and no question unless it is natural. Two sentences at most.",
  ].join(" "),
  evening: [
    "This is the end-of-day check. Keep it light: the working day is wrapping up.",
    "If tomorrow has anything on it, mention the first item. If there is still something later today, mention that instead.",
    "Ask whether there is anything they want you to remind them of tomorrow, and close warmly for the time of day.",
  ].join(" "),
};

function systemPrompt(user: UserRow, kind: RoutineKind, facts: RoutineFacts, now: Date): string {
  const tz = user.timezone;
  const who = user.profile?.callName;
  const name = user.assistantName ?? DEFAULT_ASSISTANT_NAME;
  const list = (items: string[]) => (items.length ? items.map((l) => `- ${l}`).join("\n") : "- (nothing)");
  return [
    `You are ${name}, the personal secretary of the person you are writing to, working with them over WhatsApp. You are sending a message on your own initiative; they did not ask for it.`,
    personaBlock(name, findPersona(user.persona)),
    "",
    `Now: ${formatDay(now, tz)}, ${formatClock(now, tz)}.`,
    `How to address them: ${who ?? "(not set; use \"Anda\", no honorific)"}.`,
    `What they do: ${user.profile?.work ?? "(not told)"}.`,
    "",
    "Today's agenda (still to come):",
    list(facts.today),
    "Tomorrow:",
    list(facts.tomorrow),
    ...(facts.mail.length ? ["Important unread email:", list(facts.mail)] : []),
    ...(facts.calendarNote ? [`Note: ${facts.calendarNote}`] : []),
    "",
    TASK[kind],
    "",
    "Write like a thoughtful human secretary texting someone they know well: natural everyday Indonesian, warm, brief (under 60 words). Word it freshly; do not open with a stock phrase. No headings, no bold, no em dashes, at most one emoji.",
    "Unless your persona says otherwise, stay polite: everyday but not slang (\"sudah\", \"saja\", \"ya\", not \"udah\", \"aja\", \"nih\"). Greet for the actual time of day: pagi until about 11.00, siang until 15.00, sore until 18.00, malam after.",
    "Use only the facts above. Never invent an appointment, a time, a name or a number. Output only the message itself.",
  ].join("\n");
}

/** Every time the message mentions must be on the agenda: a wrong meeting time is worse than a plain message. */
export function factsHold(text: string, facts: RoutineFacts, allowed: string[] = []): boolean {
  const ok = new Set([...facts.times, ...allowed]);
  return clocksIn(text).every((t) => ok.has(t));
}

/** Plain, correct, and varied just enough by date that it does not repeat word for word every day. */
export function fallbackRoutine(kind: RoutineKind, user: UserRow, facts: RoutineFacts, now: Date): string {
  const who = user.profile?.callName ? `, ${user.profile.callName}` : "";
  const day = Number(localNow(user.timezone, now).date.slice(8, 10));
  const pick = <T>(options: T[]): T => options[day % options.length]!;
  switch (kind) {
    case "morning": {
      if (!facts.today.length) {
        return pick([
          `Selamat pagi${who}. Hari ini kalender masih kosong. Ada rencana apa hari ini? Nanti saya bantu ingatkan.`,
          `Pagi${who}. Belum ada agenda untuk hari ini. Kalau ada janji atau tenggat, kabari saja, biar saya catat.`,
        ]);
      }
      const mail = facts.mail.length
        ? ` Ada ${facts.mail.length} email penting yang belum dibaca: ${facts.mail.join("; ")}.`
        : "";
      if (facts.today.length >= 3) {
        return [
          `Selamat pagi${who}. Hari ini ada ${facts.today.length} agenda:`,
          ...facts.today.map((l) => `• ${l}`),
          `${mail.trim()}${mail ? " " : ""}Ada lagi yang perlu saya catat untuk hari ini?`,
        ].join("\n");
      }
      return `Selamat pagi${who}. Hari ini ada ${facts.today.join(", lalu ")}.${mail} Ada lagi yang perlu saya catat untuk hari ini?`;
    }
    case "lunch":
      return pick([
        `Sudah jam makan siang${who}. Jeda sebentar dan makan dulu, ya.`,
        `Waktunya istirahat${who}. Jangan lupa makan siang.`,
        `Sudah siang${who}. Sempatkan makan dulu sebelum lanjut, ya.`,
      ]);
    case "evening": {
      const next = facts.tomorrow[0];
      return next
        ? `Hari kerja hampir selesai${who}. Besok dimulai dengan ${next}. Ada yang perlu saya ingatkan besok?`
        : `Hari kerja hampir selesai${who}. Besok belum ada agenda. Ada yang perlu saya ingatkan besok?`;
    }
  }
}

function tidy(text: string): string {
  return text
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/\s*—\s*/g, ", ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The message to send: written by the model in the assistant's voice, or the plain template when that fails. */
export async function composeRoutine(
  kind: RoutineKind,
  user: UserRow,
  facts: RoutineFacts,
  deps: { agent?: Agent | undefined; now?: Date },
): Promise<{ text: string; written: boolean }> {
  const now = deps.now ?? new Date();
  if (deps.agent) {
    try {
      const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: "Tulis pesannya sekarang." }];
      const { text, stopReason } = await deps.agent.brief(user, systemPrompt(user, kind, facts, now), messages, { kind: "routine" });
      // A message cut off mid-word is worse than the plain one.
      const written = stopReason === "max_tokens" ? "" : tidy(text);
      const routineClock = routineTime(user.profile, kind)?.replace(":", ".");
      if (written && written.length <= 700 && factsHold(written, facts, routineClock ? [routineClock] : [])) {
        return { text: written, written: true };
      }
    } catch {
      // Falls through to the template: a check-in should not be lost because the model had a bad moment.
    }
  }
  return { text: fallbackRoutine(kind, user, facts, now), written: false };
}
