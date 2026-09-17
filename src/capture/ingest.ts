import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { sql } from "../db/index.js";
import { stagingPath, UPLOAD_PREFIX } from "../uploads/routes.js";
import type { MediaFile, WhatsApp } from "../wa/client.js";
import { extractTextFrom } from "./extract.js";

export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

const EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "video/mp4": "mp4",
  "text/plain": "txt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

export interface CaptureRow {
  id: string;
  userId: string;
  kind: string;
  title: string;
  mime: string | null;
  filePath: string | null;
  sizeBytes: string | null;
  pageCount: number | null;
  textContent: string | null;
  status: string;
  createdAt: Date;
}

/** Media ids are WhatsApp/Fonnte references, or `upload:<id>` for files that came in through the upload link. */
export async function loadInboundMedia(wa: WhatsApp, mediaId: string, maxBytes: number, mime?: string): Promise<MediaFile> {
  if (!mediaId.startsWith(UPLOAD_PREFIX)) return wa.downloadMedia(mediaId, maxBytes);
  const file = stagingPath(mediaId);
  if ((await stat(file)).size > maxBytes) throw new Error("file terlalu besar");
  return { data: await readFile(file), mimeType: mime ?? "application/octet-stream" };
}

export async function discardInboundMedia(mediaId: string): Promise<void> {
  if (mediaId.startsWith(UPLOAD_PREFIX)) await rm(stagingPath(mediaId), { force: true });
}

export function userMediaDir(userId: string): string {
  return path.resolve(config.DATA_DIR, "media", userId);
}

async function storeFile(userId: string, captureId: string, data: Buffer, mime: string, filename?: string) {
  const dir = userMediaDir(userId);
  await mkdir(dir, { recursive: true });
  const fromName = filename?.includes(".") ? filename.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  const ext = EXT[mime.split(";")[0] ?? ""] ?? (fromName || "bin");
  const file = path.join(dir, `${captureId}.${ext}`);
  await writeFile(file, data);
  return file;
}

export async function saveMediaCapture(
  wa: WhatsApp,
  userId: string,
  input: { kind: "document" | "image" | "video"; mediaId: string; filename?: string; mime?: string; caption?: string },
): Promise<{ capture: CaptureRow; note?: string }> {
  const media = await loadInboundMedia(wa, input.mediaId, MAX_MEDIA_BYTES, input.mime);
  const mime = (input.mime ?? media.mimeType).split(";")[0] ?? "application/octet-stream";
  const extracted =
    input.kind === "video"
      ? { text: null, status: "unsupported" as const, note: "isi video belum dibaca" }
      : await extractTextFrom(media.data, mime, input.filename);

  const title =
    input.filename ??
    input.caption?.slice(0, 80) ??
    (input.kind === "image" ? "Foto" : input.kind === "video" ? "Video" : "Dokumen");
  const text = [input.caption, extracted.text].filter(Boolean).join("\n\n") || null;

  const [row] = await sql<CaptureRow[]>`
    insert into captures (user_id, kind, title, mime, size_bytes, page_count, text_content, status)
    values (${userId}, ${input.kind}, ${title}, ${mime}, ${media.data.length}, ${extracted.pageCount ?? null}, ${text}, ${extracted.status})
    returning *
  `;
  const capture = row!;
  const file = await storeFile(userId, capture.id, media.data, mime, input.filename);
  await sql`update captures set file_path = ${file} where id = ${capture.id}`;
  await discardInboundMedia(input.mediaId);
  return { capture: { ...capture, filePath: file }, note: extracted.note };
}

export async function saveTextCapture(
  userId: string,
  input: { kind: "audio" | "text"; title: string; text: string; mime?: string },
): Promise<CaptureRow> {
  const [row] = await sql<CaptureRow[]>`
    insert into captures (user_id, kind, title, mime, text_content, status)
    values (${userId}, ${input.kind}, ${input.title}, ${input.mime ?? null}, ${input.text}, 'ready')
    returning *
  `;
  return row!;
}

export async function deleteUserMedia(userId: string): Promise<void> {
  await rm(userMediaDir(userId), { recursive: true, force: true });
}
