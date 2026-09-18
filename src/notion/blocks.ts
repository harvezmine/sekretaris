/**
 * Notion stores a page as a list of blocks, not as text. Milo writes for WhatsApp, so this translates between the
 * two: "# " headings, "- " bullets, "1. " numbers and "[ ] " checkboxes go in as real Notion blocks, and what
 * comes back out is plain text a WhatsApp reply can carry.
 */

/** Notion refuses rich text longer than this in one block, and a request carrying more than 100 children. */
const MAX_TEXT = 2000;
export const MAX_BLOCKS = 100;

type RichText = { type: "text"; text: { content: string } };
export interface Block {
  object: "block";
  type: string;
  [key: string]: unknown;
}

function rich(text: string): RichText[] {
  return text ? [{ type: "text", text: { content: text.slice(0, MAX_TEXT) } }] : [];
}

function block(type: string, text: string, extra: Record<string, unknown> = {}): Block {
  return { object: "block", type, [type]: { rich_text: rich(text), ...extra } };
}

/**
 * One line, one block. WhatsApp bold and italic markers are left in the text rather than translated: turning
 * them into Notion annotations would mean parsing nested spans for a gain nobody reading a note would notice.
 */
export function textToBlocks(body: string): Block[] {
  const out: Block[] = [];
  for (const raw of body.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const todo = /^[-*•]?\s*\[( |x|X)\]\s+(.+)$/.exec(line);
    const bullet = /^[-*•]\s+(.+)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.+)$/.exec(line);
    const quote = /^>\s+(.+)$/.exec(line);

    if (todo) out.push(block("to_do", todo[2]!, { checked: todo[1]!.toLowerCase() === "x" }));
    else if (heading) out.push(block(`heading_${Math.min(heading[1]!.length + 1, 3)}`, heading[2]!));
    else if (bullet) out.push(block("bulleted_list_item", bullet[1]!));
    else if (numbered) out.push(block("numbered_list_item", numbered[1]!));
    else if (quote) out.push(block("quote", quote[1]!));
    else out.push(block("paragraph", line));
    if (out.length >= MAX_BLOCKS) break;
  }
  return out.length ? out : [block("paragraph", body.trim().slice(0, MAX_TEXT))];
}

interface RawBlock {
  type?: string;
  has_children?: boolean;
  [key: string]: unknown;
}

function plain(value: unknown): string {
  const parts = (value as { rich_text?: { plain_text?: string; text?: { content?: string } }[] } | undefined)?.rich_text;
  if (!parts) return "";
  return parts.map((p) => p.plain_text ?? p.text?.content ?? "").join("").trim();
}

/** The other direction: a page, flattened to something readable in a chat bubble. */
export function blocksToText(blocks: RawBlock[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    const type = b.type ?? "";
    const text = plain(b[type]);
    switch (type) {
      case "heading_1":
      case "heading_2":
      case "heading_3":
        if (text) lines.push("", `*${text}*`);
        break;
      case "bulleted_list_item":
      case "numbered_list_item":
        if (text) lines.push(`• ${text}`);
        break;
      case "to_do": {
        const done = Boolean((b[type] as { checked?: boolean } | undefined)?.checked);
        if (text) lines.push(`${done ? "✅" : "⬜"} ${text}`);
        break;
      }
      case "quote":
        if (text) lines.push(`_${text}_`);
        break;
      case "divider":
        lines.push("—");
        break;
      case "child_page":
        lines.push(`📄 ${String((b.child_page as { title?: string } | undefined)?.title ?? "halaman")}`);
        break;
      case "child_database":
        lines.push(`🗂️ ${String((b.child_database as { title?: string } | undefined)?.title ?? "database")}`);
        break;
      default:
        if (text) lines.push(text);
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The title of a page or data source, wherever Notion happened to put it in that object. */
export function titleOf(item: Record<string, unknown>): string {
  const direct = item.title as { plain_text?: string }[] | undefined;
  if (Array.isArray(direct) && direct.length) return direct.map((t) => t.plain_text ?? "").join("").trim() || "(tanpa judul)";
  const props = item.properties as Record<string, { type?: string; title?: { plain_text?: string }[] }> | undefined;
  for (const value of Object.values(props ?? {})) {
    if (value?.type === "title" && Array.isArray(value.title)) {
      const text = value.title.map((t) => t.plain_text ?? "").join("").trim();
      if (text) return text;
    }
  }
  return "(tanpa judul)";
}
