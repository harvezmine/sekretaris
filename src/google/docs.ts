import { escapeHtml } from "../web/page.js";
import { uploadToDrive, type DriveFile } from "./drive.js";

/**
 * Turning something Milo wrote into a real Google Doc. Drive converts an uploaded HTML file into a native
 * document, so this needs no permission beyond the drive.file scope Milo already has for saving files.
 */

export const DOC_MIME = "application/vnd.google-apps.document";

const BOLD = /\*([^*\n]+)\*/g;
const ITALIC = /_([^_\n]+)_/g;

/** Inline WhatsApp formatting, applied after escaping so the text itself can never open a tag. */
function inline(text: string): string {
  return escapeHtml(text).replace(BOLD, "<b>$1</b>").replace(ITALIC, "<i>$1</i>");
}

/**
 * The model writes for WhatsApp, so that is what this accepts: "# " headings, "- " or "• " bullets, "1. "
 * numbers, blank lines between paragraphs. Anything else becomes an ordinary paragraph.
 */
export function bodyToHtml(body: string): string {
  const out: string[] = [];
  let list: "ul" | "ol" | undefined;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = undefined;
  };

  for (const raw of body.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^[-•*]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);

    if (heading) {
      closeList();
      out.push(`<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`);
    } else if (bullet) {
      if (list !== "ul") {
        closeList();
        list = "ul";
        out.push("<ul>");
      }
      out.push(`<li>${inline(bullet[1]!)}</li>`);
    } else if (numbered) {
      if (list !== "ol") {
        closeList();
        list = "ol";
        out.push("<ol>");
      }
      out.push(`<li>${inline(numbered[1]!)}</li>`);
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join("\n");
}

export async function createDoc(userId: string, title: string, body: string): Promise<DriveFile> {
  const name = title.trim().slice(0, 200) || "Dokumen dari Milo";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(name)}</title></head><body>\n${bodyToHtml(body)}\n</body></html>`;
  return uploadToDrive(userId, {
    name,
    mime: "text/html",
    data: Buffer.from(html, "utf8"),
    convertTo: DOC_MIME,
    appProperties: { milo: "doc" },
  });
}
