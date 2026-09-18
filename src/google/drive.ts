import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { saveBufferCapture, type CaptureRow } from "../capture/ingest.js";
import { callGoogle, downloadGoogle, ENDPOINTS, SCOPE } from "./client.js";

const FILES = `${ENDPOINTS.drive}/files`;
const READ = [SCOPE.driveRead, SCOPE.driveFile];
const WRITE = [SCOPE.driveFile];
const FOLDER = "application/vnd.google-apps.folder";
export const MAX_DRIVE_BYTES = 25 * 1024 * 1024;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
}

const FIELDS = "id,name,mimeType,modifiedTime,size,webViewLink";

/** Drive query strings are single-quoted; backslashes and quotes inside must be escaped. */
export function driveLiteral(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export async function searchDrive(userId: string, query: string, max = 10): Promise<DriveFile[]> {
  const q = query.trim();
  const filter = q
    ? `(name contains ${driveLiteral(q)} or fullText contains ${driveLiteral(q)}) and trashed = false and mimeType != '${FOLDER}'`
    : `trashed = false and mimeType != '${FOLDER}'`;
  const res = await callGoogle<{ files?: DriveFile[] }>(userId, READ, {
    url: FILES,
    query: {
      q: filter,
      pageSize: Math.min(Math.max(max, 1), 20),
      fields: `files(${FIELDS})`,
      ...(q ? {} : { orderBy: "modifiedTime desc" }),
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    },
  });
  return res.files ?? [];
}

const EXPORTS: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document": { mime: "text/plain", ext: "txt" },
  "application/vnd.google-apps.presentation": { mime: "text/plain", ext: "txt" },
  "application/vnd.google-apps.spreadsheet": { mime: "text/csv", ext: "csv" },
};

export class DriveUnsupportedError extends Error {
  constructor(mimeType: string) {
    super(`jenis file Google ini (${mimeType}) belum bisa dibaca`);
    this.name = "DriveUnsupportedError";
  }
}

/** Downloads (or exports) a file and stores it as a capture, so the usual capture tools can read it. */
export async function importDriveFile(userId: string, fileId: string): Promise<{ file: DriveFile; capture: CaptureRow; note?: string }> {
  const file = await callGoogle<DriveFile>(userId, READ, {
    url: `${FILES}/${encodeURIComponent(fileId)}`,
    query: { fields: FIELDS, supportsAllDrives: true },
  });
  const exported = EXPORTS[file.mimeType];
  if (!exported && file.mimeType.startsWith("application/vnd.google-apps.")) throw new DriveUnsupportedError(file.mimeType);
  const media = exported
    ? await downloadGoogle(userId, READ, { url: `${FILES}/${encodeURIComponent(fileId)}/export`, query: { mimeType: exported.mime } }, MAX_DRIVE_BYTES)
    : await downloadGoogle(userId, READ, { url: `${FILES}/${encodeURIComponent(fileId)}`, query: { alt: "media", supportsAllDrives: true } }, MAX_DRIVE_BYTES);
  const mime = exported?.mime ?? (file.mimeType || media.mimeType);
  const filename = exported ? `${file.name}.${exported.ext}` : file.name;
  const saved = await saveBufferCapture(userId, {
    kind: mime.startsWith("image/") ? "image" : "document",
    data: media.data,
    mime,
    filename,
    title: `${file.name} (Drive)`,
  });
  return { file, ...saved };
}

export async function miloFolder(userId: string): Promise<string> {
  const found = await callGoogle<{ files?: { id: string }[] }>(userId, WRITE, {
    url: FILES,
    query: {
      q: `mimeType = '${FOLDER}' and trashed = false and appProperties has { key='milo' and value='folder' }`,
      fields: "files(id)",
      pageSize: 1,
    },
  });
  const existing = found.files?.[0]?.id;
  if (existing) return existing;
  const created = await callGoogle<{ id: string }>(userId, WRITE, {
    method: "POST",
    url: FILES,
    query: { fields: "id" },
    json: { name: "Milo", mimeType: FOLDER, appProperties: { milo: "folder" } },
  });
  return created.id;
}

export interface UploadInput {
  name: string;
  mime: string;
  data: Buffer;
  /** A Google type to convert the upload into, e.g. a Docs document or a Sheets spreadsheet. */
  convertTo?: string | undefined;
  appProperties?: Record<string, string> | undefined;
}

/** One multipart upload into the user's "Milo" folder, optionally converted to a native Google file. */
export async function uploadToDrive(userId: string, input: UploadInput): Promise<DriveFile> {
  const folder = await miloFolder(userId);
  const boundary = `milo-${randomBytes(12).toString("hex")}`;
  const metadata = JSON.stringify({
    name: input.name,
    parents: [folder],
    ...(input.convertTo ? { mimeType: input.convertTo } : {}),
    ...(input.appProperties ? { appProperties: input.appProperties } : {}),
  });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${input.mime}\r\n\r\n`),
    input.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return callGoogle<DriveFile>(userId, WRITE, {
    method: "POST",
    url: `${ENDPOINTS.driveUpload}/files`,
    query: { uploadType: "multipart", fields: FIELDS },
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body: new Uint8Array(body),
  });
}

/** Uploads a saved capture's original file into the user's "Milo" folder. */
export async function saveToDrive(
  userId: string,
  capture: Pick<CaptureRow, "title" | "mime" | "filePath" | "textContent">,
  name?: string,
): Promise<DriveFile> {
  const data = capture.filePath ? await readFile(capture.filePath) : Buffer.from(capture.textContent ?? "", "utf8");
  const mime = capture.filePath ? (capture.mime ?? "application/octet-stream") : "text/plain";
  return uploadToDrive(userId, { name: name ?? capture.title, mime, data });
}
