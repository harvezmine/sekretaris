import type { UserRow } from "../db/index.js";
import { messageSendFor } from "../relay/service.js";
import { serverToolsFor } from "../servers/registry.js";
import { enabledServices, googleEnabled, type GoogleService } from "../google/client.js";
import { directAttachments } from "../uploads/links.js";
import type { Button } from "../wa/client.js";
import { helpText } from "./copy.js";

// ---- quick actions ------------------------------------------------------------------------------------------------------

export type QuickAction =
  | "agenda"
  | "reminder"
  | "file"
  | "message"
  | "server"
  | "connect"
  | "style"
  | "profile"
  | "help"
  | "account"
  | "location";

export const QUICK_ACTIONS = new Set<QuickAction>([
  "agenda",
  "reminder",
  "file",
  "message",
  "server",
  "connect",
  "style",
  "profile",
  "help",
  "account",
  "location",
]);

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
    ...(googleEnabled() ? [{ id: "qa:connect", title: "🔗 Koneksi akun", description: "Google Kalender, Gmail, dan Drive" }] : []),
    { id: "qa:style", title: "🎭 Ganti nama & gaya", description: "14 kepribadian, cowok dan cewek" },
    { id: "qa:profile", title: "👤 Profil saya", description: "Panggilan, preferensi, dan yang saya ingat" },
    { id: "qa:help", title: "💡 Contoh perintah", description: "Hal-hal yang bisa saya kerjakan" },
    { id: "qa:account", title: "💳 Paket & langganan", description: "Masa aktif dan perpanjangan" },
  ];
}

export function helpFor(user: Pick<UserRow, "waId">): string {
  return helpText({
    attachments: directAttachments(),
    servers: serverToolsFor(user.waId),
    google: googleEnabled(),
  });
}

/** Single-word commands that open a quick action without the model. */
const KEYWORD_ACTIONS: [RegExp, QuickAction][] = [
  [/^(gaya|persona)$/i, "style"],
  [/^(file|upload|unggah|kirim file)$/i, "file"],
  [/^(profil|profile)$/i, "profile"],
  [/^(agenda|jadwal)( hari ini)?$/i, "agenda"],
  [/^(bantuan|help|contoh)$/i, "help"],
  [/^(koneksi|integrasi|google|hubungkan akun)$/i, "connect"],
  [/^(lokasi|kirim lokasi|share ?loc|lokasi saya)$/i, "location"],
];

export function keywordAction(text: string): QuickAction | undefined {
  const t = text.trim();
  return KEYWORD_ACTIONS.find(([re]) => re.test(t))?.[1];
}

// ---- getting to know the user -------------------------------------------------------------------------------------------

export const SETUP_ORDER = ["callName", "work", "connect"] as const;
export type SetupStep = (typeof SETUP_ORDER)[number];

export function isSetupStep(value: unknown): value is SetupStep {
  return typeof value === "string" && (SETUP_ORDER as readonly string[]).includes(value);
}

/** The last step only appears when there is something to connect. */
export function withConnectStep(user: Pick<UserRow, "waId">): boolean {
  return googleEnabled() || serverToolsFor(user.waId);
}

export function nextStep(step: SetupStep, connect = false): SetupStep | undefined {
  const next = SETUP_ORDER[SETUP_ORDER.indexOf(step) + 1];
  return next === "connect" && !connect ? undefined : next;
}

export type ConnectChoice = GoogleService | "google" | "server";

export const CONNECT_ROWS: Record<GoogleService, Button> = {
  calendar: { id: "conn:google:calendar", title: "📅 Google Kalender", description: "Agenda, jadwal, dan undangan rapat" },
  gmail: { id: "conn:google:gmail", title: "📧 Gmail", description: "Cari, baca, dan balas email" },
  drive: { id: "conn:google:drive", title: "📁 Google Drive", description: "Cari dan simpan dokumen" },
  contacts: { id: "conn:google:contacts", title: "👤 Google Kontak", description: "Cari nomor orang tanpa mengetik nomornya" },
  tasks: { id: "conn:google:tasks", title: "✅ Google Tasks", description: "Daftar tugas yang ikut muncul di laptop" },
  forms: { id: "conn:google:forms", title: "📝 Google Formulir", description: "Buat form pesanan atau survei, lalu baca jawabannya" },
};

export function parseConnectChoice(text: string): ConnectChoice | undefined {
  const t = text.trim().toLowerCase();
  if (/^(semua|google|semua akun google|akun google)$/.test(t)) return "google";
  if (/kalender|calendar|jadwal/.test(t)) return "calendar";
  if (/gmail|e-?mail|surel/.test(t)) return "gmail";
  if (/drive|dokumen/.test(t)) return "drive";
  if (/kontak|contact/.test(t)) return "contacts";
  if (/task|tugas|to.?do/.test(t)) return "tasks";
  if (/form|formulir|survei|survey/.test(t)) return "forms";
  if (/server/.test(t)) return "server";
  return undefined;
}

/** The ways people say yes in a chat, so setup does not need buttons to be answerable. */
export function isYes(text: string): boolean {
  return /^(ya|iya|iyaa+|yes|y|ok|oke|okay|okey|boleh|mau|sip|siap|silakan|silahkan|ayo|gas|bisa|lanjut|setuju)\b/i.test(text.trim());
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
      return words > 4;
    case "work":
      return words > 30;
    default:
      return words > 6;
  }
}
