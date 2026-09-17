import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

export interface Extracted {
  text: string | null;
  pageCount?: number;
  status: "ready" | "unsupported" | "failed";
  note?: string;
}

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TEXTUAL = /^(text\/|application\/(json|xml|csv|x-ndjson))/;

export async function extractTextFrom(data: Buffer, mime: string, filename = ""): Promise<Extracted> {
  const lower = filename.toLowerCase();
  try {
    if (mime === "application/pdf" || lower.endsWith(".pdf")) {
      const pdf = await getDocumentProxy(new Uint8Array(data));
      const { totalPages, text } = await extractText(pdf, { mergePages: true });
      const clean = text.replace(/[ \t]+\n/g, "\n").trim();
      if (!clean) {
        return { text: null, pageCount: totalPages, status: "unsupported", note: "PDF hasil scan (tanpa lapisan teks)" };
      }
      return { text: clean, pageCount: totalPages, status: "ready" };
    }
    if (mime === DOCX || lower.endsWith(".docx")) {
      const { value } = await mammoth.extractRawText({ buffer: data });
      return { text: value.trim(), status: "ready" };
    }
    if (TEXTUAL.test(mime) || /\.(txt|md|csv|json)$/.test(lower)) {
      return { text: data.toString("utf8"), status: "ready" };
    }
    if (mime.startsWith("image/")) {
      return { text: null, status: "ready", note: "gambar" };
    }
    return { text: null, status: "unsupported", note: `format ${mime} belum didukung` };
  } catch (err) {
    return { text: null, status: "failed", note: err instanceof Error ? err.message : String(err) };
  }
}
