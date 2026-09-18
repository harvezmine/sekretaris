import { callGoogle, ENDPOINTS, SCOPE } from "./client.js";
import { driveLiteral, miloFolder, type DriveFile } from "./drive.js";
import { formatDateTime } from "../util.js";

/**
 * A notebook the user can open on a laptop: Milo keeps one spreadsheet per topic ("omzet", "pengeluaran") and
 * adds a row whenever they mention something worth keeping.
 *
 * Only sheets Milo created are touched, which is what the drive.file scope already allows — Milo never sees the
 * rest of the user's Drive through this.
 */

export const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const WRITE = [SCOPE.driveFile];
const FILES = `${ENDPOINTS.drive}/files`;
const FIELDS = "id,name,mimeType,modifiedTime,webViewLink";
/** The header row lives in A1:Z1, so a notebook tops out at 26 columns. */
const MAX_COLUMNS = 26;
const DATE_COLUMN = "Tanggal";

export interface SheetRef {
  id: string;
  name: string;
  link: string | undefined;
}

export type CellValue = string | number;

function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function title(name: string): string {
  return name.trim().slice(0, 100) || "Catatan";
}

/**
 * A leading "=" or "@" would make Sheets evaluate a cell as a formula. Text Milo writes can come from an email or
 * a document, so it is quoted instead; numbers and dates still go in as numbers and dates.
 */
function safeCell(value: CellValue): CellValue {
  if (typeof value === "number") return value;
  const text = String(value).replace(/\r/g, "").slice(0, 500);
  return /^[=@]/.test(text) ? `'${text}` : text;
}

async function findSheet(userId: string, name: string): Promise<SheetRef | undefined> {
  const res = await callGoogle<{ files?: DriveFile[] }>(userId, WRITE, {
    url: FILES,
    query: {
      q: `mimeType = '${SHEET_MIME}' and trashed = false and appProperties has { key='miloSheet' and value=${driveLiteral(slug(name))} }`,
      fields: `files(${FIELDS})`,
      pageSize: 1,
    },
  });
  const file = res.files?.[0];
  return file ? { id: file.id, name: file.name, link: file.webViewLink } : undefined;
}

export async function listSheets(userId: string, max = 10): Promise<SheetRef[]> {
  const res = await callGoogle<{ files?: DriveFile[] }>(userId, WRITE, {
    url: FILES,
    query: {
      q: `mimeType = '${SHEET_MIME}' and trashed = false and appProperties has { key='miloSheet' }`,
      fields: `files(${FIELDS})`,
      orderBy: "modifiedTime desc",
      pageSize: Math.min(Math.max(max, 1), 20),
    },
  });
  return (res.files ?? []).map((f) => ({ id: f.id, name: f.name, link: f.webViewLink }));
}

async function createSheet(userId: string, name: string): Promise<SheetRef> {
  const folder = await miloFolder(userId);
  const created = await callGoogle<DriveFile>(userId, WRITE, {
    method: "POST",
    url: FILES,
    query: { fields: FIELDS },
    json: { name: title(name), mimeType: SHEET_MIME, parents: [folder], appProperties: { miloSheet: slug(name) } },
  });
  return { id: created.id, name: created.name, link: created.webViewLink };
}

export async function findOrCreateSheet(userId: string, name: string): Promise<{ sheet: SheetRef; created: boolean }> {
  const existing = await findSheet(userId, name);
  if (existing) return { sheet: existing, created: false };
  return { sheet: await createSheet(userId, name), created: true };
}

async function values(userId: string, sheetId: string, range: string): Promise<CellValue[][]> {
  const res = await callGoogle<{ values?: CellValue[][] }>(userId, WRITE, {
    url: `${ENDPOINTS.sheets}/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}`,
  });
  return res.values ?? [];
}

async function writeHeader(userId: string, sheetId: string, header: string[]): Promise<void> {
  await callGoogle(userId, WRITE, {
    method: "PUT",
    url: `${ENDPOINTS.sheets}/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(`A1:${String.fromCharCode(64 + header.length)}1`)}`,
    query: { valueInputOption: "RAW" },
    json: { values: [header] },
  });
}

export interface AppendResult {
  sheet: SheetRef;
  created: boolean;
  header: string[];
  row: CellValue[];
}

/**
 * Adds one row, matching the columns already in the sheet and extending the header when the user mentions
 * something new. Every row gets a date, because a log without one answers nothing later.
 */
export async function appendRow(
  userId: string,
  sheetName: string,
  fields: Record<string, CellValue>,
  opts: { timeZone: string; now?: Date },
): Promise<AppendResult> {
  const { sheet, created } = await findOrCreateSheet(userId, sheetName);
  const header = created ? [] : (await values(userId, sheet.id, "A1:Z1"))[0]?.map(String).filter(Boolean) ?? [];

  const entries = new Map<string, CellValue>();
  for (const [key, value] of Object.entries(fields)) {
    const column = key.trim().slice(0, 40);
    if (column && value !== undefined && value !== null) entries.set(column, value);
  }
  if (!header.includes(DATE_COLUMN) && ![...entries.keys()].some((k) => k.toLowerCase() === DATE_COLUMN.toLowerCase())) {
    entries.set(DATE_COLUMN, formatDateTime(opts.now ?? new Date(), opts.timeZone));
  }

  const nextHeader = [...header];
  if (!nextHeader.length && entries.has(DATE_COLUMN)) nextHeader.push(DATE_COLUMN);
  for (const column of entries.keys()) {
    if (!nextHeader.some((h) => h.toLowerCase() === column.toLowerCase()) && nextHeader.length < MAX_COLUMNS) nextHeader.push(column);
  }
  if (nextHeader.length !== header.length || nextHeader.some((h, i) => h !== header[i])) {
    await writeHeader(userId, sheet.id, nextHeader);
  }

  const row = nextHeader.map((column) => {
    const key = [...entries.keys()].find((k) => k.toLowerCase() === column.toLowerCase());
    return key === undefined ? "" : safeCell(entries.get(key)!);
  });
  await callGoogle(userId, WRITE, {
    method: "POST",
    url: `${ENDPOINTS.sheets}/spreadsheets/${encodeURIComponent(sheet.id)}/values/${encodeURIComponent("A1")}:append`,
    query: { valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS" },
    json: { values: [row] },
  });
  return { sheet, created, header: nextHeader, row };
}

export interface SheetRows {
  sheet: SheetRef;
  header: string[];
  rows: Record<string, CellValue>[];
  total: number;
}

/** The most recent rows, as objects, so the model can total or summarise them. */
export async function readRows(userId: string, sheetName: string, limit = 20): Promise<SheetRows | undefined> {
  const sheet = await findSheet(userId, sheetName);
  if (!sheet) return undefined;
  const all = await values(userId, sheet.id, "A1:Z1000");
  const header = all[0]?.map(String) ?? [];
  const body = all.slice(1).filter((row) => row.some((cell) => String(cell ?? "").trim()));
  const rows = body.slice(-Math.min(Math.max(limit, 1), 100)).map((row) => {
    const entry: Record<string, CellValue> = {};
    header.forEach((column, i) => {
      if (column) entry[column] = row[i] ?? "";
    });
    return entry;
  });
  return { sheet, header, rows, total: body.length };
}
