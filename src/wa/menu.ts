import type { Button } from "./client.js";

/** Plain-text stand-in for reply buttons on channels that cannot send them. */
export function renderMenu(body: string, buttons: Button[]): string {
  const lines = buttons.map((b, i) => `*${i + 1}.* ${b.title}${b.description ? ` — ${b.description}` : ""}`);
  return `${body}\n\nBalas dengan angka:\n${lines.join("\n")}`;
}

/** Maps "2", "2.", "(2)" or the button title itself back to the button it stands for. */
export function matchMenuReply(text: string, buttons: Button[]): Button | undefined {
  const t = text.trim();
  const digit = /^\(?\s*(\d{1,2})\s*[).]?$/.exec(t);
  if (digit) return buttons[Number(digit[1]) - 1];
  const key = comparable(t);
  return key ? buttons.find((b) => comparable(b.title) === key) : undefined;
}

/** Titles may carry emoji and punctuation that nobody types back. */
function comparable(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
