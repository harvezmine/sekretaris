export const WA_TEXT_LIMIT = 4096;

const BOLD_OPEN = String.fromCharCode(1);
const BOLD_CLOSE = String.fromCharCode(2);
const SLOT = String.fromCharCode(3);
const SLOT_PATTERN = new RegExp(SLOT + "(\\d+)" + SLOT, "g");

/**
 * Converts the Markdown a model tends to produce into WhatsApp's own formatting. Single asterisks are left alone:
 * the model is told to write *bold* the WhatsApp way, so they are bold, not Markdown italics.
 */
export function toWhatsApp(markdown: string): string {
  const protectedParts: string[] = [];
  const protect = (s: string) => {
    protectedParts.push(s);
    return `${SLOT}${protectedParts.length - 1}${SLOT}`;
  };

  let out = markdown.replace(/\r\n/g, "\n");
  out = out.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, (_m, body: string) => protect("```\n" + body + "```"));
  out = out.replace(/`[^`\n]+`/g, (m) => protect(m));

  out = out.replace(/^\s*(?:---+|\*\*\*+|___+)\s*$/gm, "");
  out = out.replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, (_m, title: string) => {
    const plain = title.replace(/\*\*|__/g, "").trim();
    return `${BOLD_OPEN}${plain}${BOLD_CLOSE}`;
  });

  out = out.replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`);
  out = out.replace(/__(?=\S)([\s\S]+?)(?<=\S)__/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`);

  out = out.replace(/^(\s*)[-*+]\s+/gm, "$1• ");
  out = out.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "~$1~");

  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, text: string, url: string) =>
    text.trim() === url ? url : `${text} (${url})`,
  );

  out = out.replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, "");
  out = out.replace(/^\|(.+)\|\s*$/gm, (_m, row: string) =>
    row
      .split("|")
      .map((c) => c.trim())
      .join(" — "),
  );

  out = out.split(BOLD_OPEN).join("*").split(BOLD_CLOSE).join("*");
  out = out.replace(SLOT_PATTERN, (_m, i: string) => protectedParts[Number(i)] ?? "");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

/** Splits text into WhatsApp-sized messages, preferring paragraph and sentence boundaries. */
export function chunkText(text: string, max = WA_TEXT_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n\n");
    if (cut < max * 0.5) cut = window.lastIndexOf("\n");
    if (cut < max * 0.5) {
      const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
      cut = sentence > 0 ? sentence + 1 : -1;
    }
    if (cut < max * 0.5) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
