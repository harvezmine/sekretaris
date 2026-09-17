import type { UserRow } from "../db/index.js";
import { DEFAULT_ASSISTANT_NAME, findPersona, PERSONAS, type Persona } from "../persona/catalog.js";
import { clockLabel, normalizeCallName, styleLabel, type UserProfile } from "../profile/profile.js";
import { messageSendFor } from "../relay/service.js";
import { serverToolsFor } from "../servers/registry.js";
import { directAttachments } from "../uploads/links.js";
import type { Button } from "../wa/client.js";
import { helpText, SETUP_BTN } from "./copy.js";

// ---- quick actions ------------------------------------------------------------------------------------------------------

export type QuickAction = "agenda" | "reminder" | "file" | "message" | "server" | "style" | "profile" | "help" | "account";

export const QUICK_ACTIONS = new Set<QuickAction>(["agenda", "reminder", "file", "message", "server", "style", "profile", "help", "account"]);

export const QUICK_MENU_LABEL = "Pilih menu";

/** The rows shown for MENU. List rows allow 24 characters for the title and 72 for the description. */
export function quickRows(user: Pick<UserRow, "waId">): Button[] {
  const messaging = messageSendFor(user.waId);
  return [
    { id: "qa:agenda", title: "📅 Agenda hari ini", description: "Pengingat hari ini dan besok" },
    { id: "qa:reminder", title: "⏰ Buat pengingat", description: "Janji, tenggat, atau tugas" },
    { id: "qa:file", title: "📎 Kirim file", description: "PDF, Word, atau foto untuk saya baca" },
    {
      id: "qa:message",
      title: messaging ? "✉️ Kirim pesan" : "✉️ Susun pesan",
      description: messaging ? "Ke kontak Anda, terkirim setelah Anda setujui" : "Saya buatkan, Anda yang kirim",
    },
    ...(serverToolsFor(user.waId) ? [{ id: "qa:server", title: "🖥️ Cek server", description: "Kondisi server dan error aplikasi" }] : []),
    { id: "qa:style", title: "🎭 Ganti nama & gaya", description: "14 kepribadian, cowok dan cewek" },
    { id: "qa:profile", title: "👤 Profil saya", description: "Panggilan, preferensi, dan yang saya ingat" },
    { id: "qa:help", title: "💡 Contoh perintah", description: "Hal-hal yang bisa saya kerjakan" },
    { id: "qa:account", title: "💳 Paket & langganan", description: "Masa aktif dan perpanjangan" },
  ];
}

export function helpFor(user: Pick<UserRow, "waId">): string {
  return helpText({ attachments: directAttachments(), messaging: messageSendFor(user.waId), servers: serverToolsFor(user.waId) });
}

/** Single-word commands that open a quick action without the model. */
const KEYWORD_ACTIONS: [RegExp, QuickAction][] = [
  [/^(gaya|persona)$/i, "style"],
  [/^(file|upload|unggah|kirim file)$/i, "file"],
  [/^(profil|profile)$/i, "profile"],
  [/^(agenda|jadwal)( hari ini)?$/i, "agenda"],
  [/^(bantuan|help|contoh)$/i, "help"],
];

export function keywordAction(text: string): QuickAction | undefined {
  const t = text.trim();
  return KEYWORD_ACTIONS.find(([re]) => re.test(t))?.[1];
}

// ---- getting to know the user -------------------------------------------------------------------------------------------

export const SETUP_ORDER = ["callName", "work", "persona", "assistantName", "answerStyle", "briefing"] as const;
export type SetupStep = (typeof SETUP_ORDER)[number];

export function isSetupStep(value: unknown): value is SetupStep {
  return typeof value === "string" && (SETUP_ORDER as readonly string[]).includes(value);
}

export function nextStep(step: SetupStep): SetupStep | undefined {
  return SETUP_ORDER[SETUP_ORDER.indexOf(step) + 1];
}

export const SKIP = /^(lewati|skip|nanti|nanti saja|tidak|tidak usah|ga|gak|nggak|enggak|ga usah|gak usah|-)$/i;
export const FINISH = /^(selesai|sudah|udah|cukup)$/i;

const ASKING = /^(ingetin|ingatkan|tolong|kirim|kirimkan|kabari|cek|carikan|cari|jadwalkan|agenda|apa|apakah|bagaimana|gimana|kapan|siapa|berapa|kenapa|mengapa|bisakah|coba)\b/i;

/** During setup, a question or instruction is not an answer: pause setup and handle it normally. */
export function looksLikeRequest(text: string, step: SetupStep): boolean {
  if (text.includes("?") || ASKING.test(text)) return true;
  const words = text.trim().split(/\s+/).length;
  switch (step) {
    case "callName":
    case "assistantName":
      return words > 4;
    case "work":
      return words > 30;
    default:
      return words > 6;
  }
}

export function parsePersonaChoice(text: string): Persona | "standard" | undefined {
  const t = text.trim().toLowerCase();
  if (/^(standar|standard|biasa|default)$/.test(t)) return "standard";
  const digits = /^(?:no\.?|nomor|nomer|angka)?\s*(\d{1,2})$/.exec(t);
  if (digits) return PERSONAS.find((p) => p.number === Number(digits[1]));
  return PERSONAS.find((p) => p.id === t.replace(/\s+/g, "-") || p.label.toLowerCase() === t);
}

export function parseAnswerStyle(text: string): UserProfile["answerStyle"] | undefined {
  const t = text.trim().toLowerCase();
  if (/^(singkat|pendek|ringkas|padat|to the point)\b/.test(t)) return "singkat";
  if (/^(lengkap|detail|detil|panjang|jelas)\b/.test(t)) return "lengkap";
  return undefined;
}

export function callNameButtons(user: Pick<UserRow, "displayName">): Button[] {
  const own = user.displayName ? normalizeCallName(user.displayName) : undefined;
  const ownButton = own && own.length <= 20 && own.toLowerCase() !== "bos" ? [{ id: "setup:call:name", title: own }] : [];
  return [...ownButton, SETUP_BTN.callBos, SETUP_BTN.skip];
}

export function assistantNameButtons(user: Pick<UserRow, "assistantName" | "persona">): Button[] {
  const current = user.assistantName ?? DEFAULT_ASSISTANT_NAME;
  const suggested = findPersona(user.persona)?.suggestedName;
  const buttons: Button[] = [];
  if (suggested && suggested !== current) buttons.push({ id: "setup:name:suggested", title: `Nama: ${suggested}`.slice(0, 20) });
  buttons.push({ ...SETUP_BTN.keepMilo, title: `Tetap ${current}`.slice(0, 20) });
  return buttons;
}

export function setupSummary(user: UserRow): string[] {
  const p = user.profile ?? {};
  const persona = findPersona(user.persona);
  return [
    `• Panggilan: ${p.callName ?? "—"}`,
    `• Pekerjaan/usaha: ${p.work ?? "—"}`,
    `• Asisten: *${user.assistantName ?? DEFAULT_ASSISTANT_NAME}*, gaya ${persona ? persona.label : "standar"}`,
    `• Jawaban: ${styleLabel(p.answerStyle)}`,
    `• Ringkasan agenda pagi: ${p.briefingTime ? `jam ${clockLabel(p.briefingTime)}` : "mati"}`,
  ];
}
