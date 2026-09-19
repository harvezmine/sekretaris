import { sql, type UserRow } from "../db/index.js";

/**
 * How this user writes, learned by counting rather than by asking. People tell you their name; they never tell you
 * they write in lowercase without full stops, and that is exactly what makes a reply feel written by a person who
 * knows them.
 *
 * Deliberately arithmetic, not a model call: it costs nothing, it is the same answer every time, and the user can
 * be shown precisely what was concluded about them.
 */

/** Below this there is not enough to conclude anything, and guessing from two messages is worse than saying nothing. */
const MIN_MESSAGES = 8;
const SAMPLE = 40;
const STALE_DAYS = 3;

export interface StyleCard {
  /** Median words per message; the median because one pasted paragraph should not redraw the whole picture. */
  words: number;
  /** How they address the assistant, when they address it at all. */
  address: "anda" | "kamu" | "campur" | "unknown";
  emoji: number;
  slang: number;
  lowercase: number;
  /** Share of messages that end without . ! or ? */
  unpunctuated: number;
  n: number;
  at: string;
}

const EMOJI = /\p{Extended_Pictographic}/u;
const SLANG = /\b(gue|gw|gua|nggak|ngga|gak|ga|aja|dong|nih|sih|banget|udah|udh|gitu|kayak|kok|deh|yaudah|oke sip)\b/i;
const FORMAL_YOU = /\b(anda)\b/i;
const CASUAL_YOU = /\b(kamu|lu|lo|elo|elu)\b/i;

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 10) / 10;
}

const share = (n: number, total: number) => Math.round((n / total) * 100) / 100;

/** Undefined when there is too little to go on; the caller then says nothing about style at all. */
export function readStyle(messages: string[], now = new Date()): StyleCard | undefined {
  const texts = messages.map((m) => m.trim()).filter((m) => m.length > 0);
  if (texts.length < MIN_MESSAGES) return undefined;
  const sample = texts.slice(-SAMPLE);

  let formal = 0;
  let casual = 0;
  let emoji = 0;
  let slang = 0;
  let lower = 0;
  let unpunctuated = 0;
  for (const text of sample) {
    if (FORMAL_YOU.test(text)) formal++;
    if (CASUAL_YOU.test(text)) casual++;
    if (EMOJI.test(text)) emoji++;
    if (SLANG.test(text)) slang++;
    const first = text[0]!;
    if (first === first.toLowerCase() && first !== first.toUpperCase()) lower++;
    if (!/[.!?]$/.test(text)) unpunctuated++;
  }

  return {
    words: median(sample.map(words)),
    address: formal && casual ? "campur" : formal ? "anda" : casual ? "kamu" : "unknown",
    emoji: share(emoji, sample.length),
    slang: share(slang, sample.length),
    lowercase: share(lower, sample.length),
    unpunctuated: share(unpunctuated, sample.length),
    n: sample.length,
    at: now.toISOString(),
  };
}

/**
 * The line the model reads. It ends with the floor: a secretary matches how their boss talks, never how carelessly
 * they talk, and least of all in anything that leaves the chat.
 */
export function describeStyle(card: StyleCard): string {
  const traits: string[] = [];
  traits.push(card.words <= 8 ? `very short messages (about ${card.words} words)` : card.words <= 20 ? `short messages (about ${card.words} words)` : `long messages (about ${card.words} words)`);
  if (card.slang >= 0.4) traits.push("everyday slang");
  else if (card.slang <= 0.1) traits.push("no slang");
  if (card.lowercase >= 0.6) traits.push("lowercase openings");
  if (card.unpunctuated >= 0.6) traits.push("no full stop at the end");
  if (card.emoji >= 0.3) traits.push("emoji often");
  else if (card.emoji === 0) traits.push("never any emoji");
  if (card.address === "anda") traits.push('calls you "Anda"');
  else if (card.address === "kamu") traits.push('calls you "kamu"');

  return [
    `How they write, counted from their own last ${card.n} messages (they never said this; do not quote it back at them): ${traits.join(", ")}.`,
    "Match that register so your reply sounds like it came from someone who works with them.",
    "Never go below a professional floor: no slang and full sentences for bad news, money, anything about their health or security, and everything you write for someone else to read.",
  ].join(" ");
}

/** The same picture in the user's own language, for the PROFIL menu, so nothing concluded about them is hidden. */
export function styleSummary(card: StyleCard): string {
  const bits: string[] = [];
  bits.push(card.words <= 8 ? "pesan pendek" : card.words <= 20 ? "pesan sedang" : "pesan panjang");
  if (card.slang >= 0.4) bits.push("santai");
  else if (card.slang <= 0.1) bits.push("rapi");
  if (card.lowercase >= 0.6) bits.push("huruf kecil");
  if (card.emoji >= 0.3) bits.push("suka emoji");
  if (card.address === "anda") bits.push("memanggil saya Anda");
  else if (card.address === "kamu") bits.push("memanggil saya kamu");
  return bits.join(", ");
}

function stale(card: StyleCard | undefined, now: Date): boolean {
  if (!card) return true;
  return now.getTime() - new Date(card.at).getTime() > STALE_DAYS * 86_400_000;
}

/**
 * Recomputed from the user's own recent messages, at most every few days: how someone writes drifts over months,
 * never between two turns, and a turn should not pay for a rewrite of it.
 */
export async function refreshStyle(user: UserRow, now = new Date()): Promise<StyleCard | undefined> {
  const current = user.profile?.style;
  if (!stale(current, now)) return current;
  const rows = await sql<{ body: string }[]>`
    select body from messages
    where user_id = ${user.id} and direction = 'in' and kind = 'text' and body is not null and body <> ''
    order by id desc limit ${SAMPLE}
  `;
  const card = readStyle(rows.map((r) => r.body).reverse(), now);
  if (!card) return current;
  // Written straight rather than through updateProfile, so this module owes nothing to the one that reads it.
  await sql`update users set profile = profile || ${sql.json({ style: card } as never)} where id = ${user.id}`;
  if (user.profile) user.profile.style = card;
  return card;
}
