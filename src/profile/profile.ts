import { ROUTINE_KINDS, ROUTINE_LABEL, routineTime } from "../routines/routines.js";
import { sql, type UserProfile, type UserRow } from "../db/index.js";
import { DEFAULT_ASSISTANT_NAME, findPersona } from "../persona/catalog.js";

export type { UserProfile };

/** "Pak Josh", "Bu Rina", "Bos", "Kak Dimas": a form of address, not a sentence. */
const CALL_NAME = /^[\p{L}\p{N}](?:[\p{L}\p{N} .'-]{0,38}[\p{L}\p{N}.])?$/u;

export function normalizeCallName(raw: string): string | undefined {
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  if (!CALL_NAME.test(name) || name.split(" ").length > 4) return undefined;
  return name;
}

export function normalizeWork(raw: string): string | undefined {
  const work = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (work.length < 2 || work.length > 200 || /[<>{}]/.test(work)) return undefined;
  return work;
}

/** Accepts "7", "07.30", "7:30", "jam 6.15", "06:00 pagi"; returns HH:MM or undefined. */
export function parseClock(raw: string): string | undefined {
  const m = /^(?:jam|pukul)?\s*(\d{1,2})(?:[.:](\d{2}))?\s*(?:pagi|wib|wita|wit)?$/i.exec(raw.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (h > 23 || min > 59) return undefined;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export const clockLabel = (hhmm: string) => hhmm.replace(":", ".");

/** Merges a patch into users.profile; a null value removes that key. */
export async function updateProfile(
  userId: string,
  patch: { [K in keyof UserProfile]?: UserProfile[K] | null },
): Promise<UserProfile> {
  const set: Record<string, unknown> = {};
  const remove: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) remove.push(key);
    else set[key] = value;
  }
  const [row] = await sql<{ profile: UserProfile }[]>`
    update users
    set profile = (profile || ${sql.json(set as never)}) - ${remove}::text[], updated_at = now()
    where id = ${userId}
    returning profile
  `;
  return row?.profile ?? {};
}

export function styleLabel(style: UserProfile["answerStyle"]): string {
  return style === "singkat" ? "singkat & padat" : style === "lengkap" ? "lengkap & detail" : "menyesuaikan";
}

/** Lines for the model's <user_profile> block. */
export function profilePromptLines(user: UserRow): string[] {
  const p = user.profile ?? {};
  return [
    `Address the user as: ${p.callName ? `${p.callName} (the user's choice; use it instead of your persona's default form of address)` : "(not set; use their name or \"Anda\")"}`,
    `Work or business: ${p.work ?? "(not told yet)"}`,
    `Answer length preference: ${
      p.answerStyle === "singkat"
        ? "short (one to three sentences unless they ask for more)"
        : p.answerStyle === "lengkap"
          ? "detailed (fuller explanations and options are welcome)"
          : "not set (keep it brief by default)"
    }`,
    `Check-ins you send on your own: ${routineSummary(p, "en")}. When they ask you to stop, move or bring one back, use profile_update.`,
  ];
}

/** What the user sees when they ask what Milo knows about them. */
export function profileSummary(user: UserRow, facts: string[]): string {
  const p = user.profile ?? {};
  const persona = findPersona(user.persona);
  const lines = [
    "👤 *Profil Anda*",
    `• Panggilan: ${p.callName ?? "_belum diatur_"}`,
    `• Pekerjaan/usaha: ${p.work ?? "_belum diatur_"}`,
    `• Jawaban: ${styleLabel(p.answerStyle)}`,
    `• Sapaan otomatis: ${routineSummary(p, "id")}`,
    `• Asisten: *${user.assistantName ?? DEFAULT_ASSISTANT_NAME}*, gaya ${persona ? `${persona.label} (${persona.gender})` : "standar"}`,
  ];
  if (facts.length) {
    lines.push("", "*Yang saya ingat:*", ...facts.slice(0, 10).map((f) => `• ${f}`));
    if (facts.length > 10) lines.push(`_…dan ${facts.length - 10} lainnya_`);
  }
  lines.push(
    "",
    "Ubah kapan saja dengan kalimat biasa, misalnya _panggil saya Pak Josh_, _jawab lebih singkat_, _sapaan pagi jam 6_, atau _tidak usah ingatkan makan siang_. Minta _lupakan …_ untuk menghapus sesuatu yang saya ingat.",
  );
  return lines.join("\n");
}

/** "pagi 07.30, siang 12.00 (hari kerja), sore mati" for the user; the English form goes to the model. */
export function routineSummary(p: UserProfile, lang: "id" | "en"): string {
  const parts = ROUTINE_KINDS.map((kind) => {
    const at = routineTime(p, kind);
    const weekdays = kind === "morning" ? "" : lang === "id" ? " (hari kerja)" : " (weekdays)";
    if (lang === "en") return `${kind} ${at ?? "off"}${at ? weekdays : ""}`;
    return `${ROUTINE_LABEL[kind]} ${at ? clockLabel(at) + weekdays : "mati"}`;
  });
  return parts.join(", ");
}
