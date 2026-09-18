import { blocksToText, MAX_BLOCKS, textToBlocks, titleOf } from "./blocks.js";
import { callNotion, NotionApiError, NotionNotSharedError } from "./client.js";

/**
 * What Milo actually does inside a workspace: find things, read a page, write a page, and work a database.
 *
 * Since API version 2025-09-03 a database is a container holding one or more data sources, and rows live in the
 * data source, not in the database. So anything row-shaped resolves the database to its data source first.
 */

const PAGE_SIZE = 50;

export interface Found {
  id: string;
  kind: "page" | "database";
  title: string;
  url?: string;
  editedAt?: string;
}

interface RawObject {
  id: string;
  object?: string;
  url?: string;
  last_edited_time?: string;
  [key: string]: unknown;
}

function shape(item: RawObject): Found {
  const kind = item.object === "page" ? "page" : "database";
  return {
    id: item.id,
    kind,
    title: titleOf(item),
    ...(item.url ? { url: item.url } : {}),
    ...(item.last_edited_time ? { editedAt: item.last_edited_time } : {}),
  };
}

/**
 * Notion searches titles, not the words inside a page. Callers say so to the user rather than implying the whole
 * workspace was read. An empty query lists what the user shared, which is the honest answer to "kamu bisa lihat apa?".
 */
export async function search(userId: string, query: string, kind?: "page" | "database", max = 10): Promise<Found[]> {
  const res = await callNotion<{ results?: RawObject[] }>(userId, {
    method: "POST",
    path: "/search",
    json: {
      ...(query.trim() ? { query: query.trim() } : {}),
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: Math.min(Math.max(max, 1), PAGE_SIZE),
    },
  });
  const all = (res.results ?? []).map(shape);
  return kind ? all.filter((f) => f.kind === kind) : all;
}

/** The closest thing to what the user called it: exact title first, then a title that contains it. */
export async function findOne(userId: string, name: string, kind?: "page" | "database"): Promise<Found | undefined> {
  const wanted = name.trim().toLowerCase();
  const hits = await search(userId, name, kind, 20);
  return (
    hits.find((h) => h.title.toLowerCase() === wanted) ??
    hits.find((h) => h.title.toLowerCase().includes(wanted)) ??
    hits.find((h) => wanted.includes(h.title.toLowerCase()))
  );
}

// ---- pages -------------------------------------------------------------------------------------------------------

export interface PageText {
  page: Found;
  text: string;
  truncated: boolean;
}

export async function readPage(userId: string, pageId: string, title: string): Promise<PageText> {
  const res = await callNotion<{ results?: Record<string, unknown>[]; has_more?: boolean }>(userId, {
    path: `/blocks/${encodeURIComponent(pageId)}/children`,
    query: { page_size: MAX_BLOCKS },
  });
  return {
    page: { id: pageId, kind: "page", title },
    text: blocksToText(res.results ?? []),
    truncated: Boolean(res.has_more),
  };
}

export interface NewPage {
  title: string;
  body: string;
  /** A page to file it under; without one, Notion puts it wherever the user granted access at the top level. */
  parentId?: string;
}

export async function createPage(userId: string, input: NewPage): Promise<Found> {
  const parent = input.parentId
    ? { type: "page_id", page_id: input.parentId }
    : await topLevelParent(userId);
  const created = await callNotion<RawObject>(userId, {
    method: "POST",
    path: "/pages",
    json: {
      parent,
      properties: { title: { title: [{ type: "text", text: { content: input.title.slice(0, 200) } }] } },
      children: textToBlocks(input.body),
    },
  });
  return shape({ ...created, object: "page" });
}

/** Without a parent named, the newest page the user shared is the least surprising place to file a note. */
async function topLevelParent(userId: string): Promise<{ type: "page_id"; page_id: string }> {
  const pages = await search(userId, "", "page", 5);
  const first = pages[0];
  if (!first) throw new NotionNotSharedError("Belum ada halaman Notion yang");
  return { type: "page_id", page_id: first.id };
}

export async function appendToPage(userId: string, pageId: string, body: string): Promise<number> {
  const children = textToBlocks(body);
  await callNotion(userId, { method: "PATCH", path: `/blocks/${encodeURIComponent(pageId)}/children`, json: { children } });
  return children.length;
}

// ---- databases ---------------------------------------------------------------------------------------------------

export interface DataSource {
  id: string;
  title: string;
  properties: Record<string, { type?: string; [key: string]: unknown }>;
}

/**
 * A database id is not a data source id, and Notion refuses one where the other belongs. Given either, this ends
 * up at the data source that actually holds the rows.
 */
export async function dataSourceOf(userId: string, databaseId: string, title: string): Promise<DataSource> {
  try {
    const db = await callNotion<{ data_sources?: { id: string; name?: string }[] }>(userId, {
      path: `/databases/${encodeURIComponent(databaseId)}`,
    });
    const first = db.data_sources?.[0];
    if (first) return await describeDataSource(userId, first.id, first.name ?? title);
  } catch (err) {
    // Older workspaces, and ids that were a data source all along, answer here instead.
    if (!(err instanceof NotionApiError) && !(err instanceof NotionNotSharedError)) throw err;
  }
  return describeDataSource(userId, databaseId, title);
}

async function describeDataSource(userId: string, id: string, title: string): Promise<DataSource> {
  const source = await callNotion<{ properties?: DataSource["properties"]; title?: { plain_text?: string }[] }>(userId, {
    path: `/data_sources/${encodeURIComponent(id)}`,
  });
  return { id, title: titleOf(source as Record<string, unknown>) || title, properties: source.properties ?? {} };
}

/**
 * Money as people here write it: "Rp 4.200.000", "4,2 juta", "500rb". A dot groups thousands and a comma is the
 * decimal point, which is the opposite of what Number() assumes, so parsing it naively turns 4.2 million into NaN.
 */
export function toNumber(input: string): number | undefined {
  const text = input.trim().toLowerCase();
  if (!text) return undefined;
  // The unit may be stuck to the number ("1,5jt"), so it only has to follow a digit or a space, not a word break.
  const unit = (re: RegExp) => re.test(text);
  const scale = unit(/(?<=[\d\s])(miliar|milyar|m)\b/) ? 1e9 : unit(/(?<=[\d\s])(juta|jt)\b/) ? 1e6 : unit(/(?<=[\d\s])(ribu|rb|k)\b/) ? 1e3 : 1;
  const digits = text.replace(/[^\d.,-]/g, "");
  if (!/\d/.test(digits)) return undefined;

  let plain: string;
  if (digits.includes(",")) {
    // A comma is the decimal point, so whatever dots are left can only be thousand markers.
    plain = digits.replace(/\./g, "").replace(",", ".");
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(digits)) {
    plain = digits.replace(/\./g, "");
  } else {
    plain = digits;
  }
  const value = Number(plain);
  return Number.isFinite(value) ? value * scale : undefined;
}

/** Turns what the model wrote into the shape each column expects; a column Notion does not have is skipped. */
export function toProperties(fields: Record<string, string | number | boolean>, schema: DataSource["properties"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(fields)) {
    const key = Object.keys(schema).find((k) => k.toLowerCase() === name.trim().toLowerCase());
    if (!key) continue;
    const type = schema[key]?.type;
    const text = String(raw).slice(0, 2000);
    switch (type) {
      case "title":
        out[key] = { title: [{ type: "text", text: { content: text } }] };
        break;
      case "rich_text":
        out[key] = { rich_text: [{ type: "text", text: { content: text } }] };
        break;
      case "number": {
        const n = typeof raw === "number" ? raw : toNumber(text);
        if (n !== undefined) out[key] = { number: n };
        break;
      }
      case "checkbox":
        out[key] = { checkbox: raw === true || /^(true|ya|yes|sudah|selesai|done)$/i.test(text) };
        break;
      case "date":
        out[key] = { date: { start: text.slice(0, 10) } };
        break;
      case "select":
        out[key] = { select: { name: text.slice(0, 100) } };
        break;
      case "multi_select":
        out[key] = { multi_select: text.split(/\s*,\s*/).filter(Boolean).map((name) => ({ name: name.slice(0, 100) })) };
        break;
      case "status":
        out[key] = { status: { name: text.slice(0, 100) } };
        break;
      case "url":
        out[key] = { url: text };
        break;
      case "email":
        out[key] = { email: text };
        break;
      case "phone_number":
        out[key] = { phone_number: text };
        break;
      default:
        break;
    }
  }
  return out;
}

/** What a row looks like coming back: property names to something printable. */
export function fromProperties(properties: Record<string, Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(properties ?? {})) {
    const type = String(value?.type ?? "");
    const v = value?.[type];
    let text = "";
    if (type === "title" || type === "rich_text") text = ((v as { plain_text?: string }[]) ?? []).map((t) => t.plain_text ?? "").join("");
    else if (type === "number") text = v === null || v === undefined ? "" : String(v);
    else if (type === "checkbox") text = v ? "ya" : "tidak";
    else if (type === "select" || type === "status") text = String((v as { name?: string } | null)?.name ?? "");
    else if (type === "multi_select") text = ((v as { name?: string }[]) ?? []).map((o) => o.name ?? "").join(", ");
    else if (type === "date") text = String((v as { start?: string } | null)?.start ?? "");
    else if (type === "url" || type === "email" || type === "phone_number") text = String(v ?? "");
    else if (type === "people") text = ((v as { name?: string }[]) ?? []).map((p) => p.name ?? "").join(", ");
    else if (type === "formula") text = String((v as { string?: string; number?: number } | null)?.string ?? (v as { number?: number } | null)?.number ?? "");
    if (text.trim()) out[name] = text.trim();
  }
  return out;
}

export interface Row {
  id: string;
  url?: string;
  fields: Record<string, string>;
}

export async function addRow(userId: string, source: DataSource, fields: Record<string, string | number | boolean>): Promise<Row> {
  const properties = toProperties(fields, source.properties);
  if (!Object.keys(properties).length) {
    throw new NotionApiError(`Tidak ada kolom yang cocok. Kolom yang ada: ${Object.keys(source.properties).join(", ") || "tidak terbaca"}.`, 400);
  }
  const created = await callNotion<RawObject>(userId, {
    method: "POST",
    path: "/pages",
    json: { parent: { type: "data_source_id", data_source_id: source.id }, properties },
  });
  return { id: created.id, ...(created.url ? { url: created.url } : {}), fields: fromProperties((created.properties ?? {}) as never) };
}

export async function queryRows(userId: string, source: DataSource, max = 20): Promise<{ rows: Row[]; more: boolean }> {
  const res = await callNotion<{ results?: RawObject[]; has_more?: boolean }>(userId, {
    method: "POST",
    path: `/data_sources/${encodeURIComponent(source.id)}/query`,
    // Notion halved the default page size in 2026, so it is always stated rather than assumed.
    json: { page_size: Math.min(Math.max(max, 1), PAGE_SIZE) },
  });
  return {
    rows: (res.results ?? []).map((r) => ({
      id: r.id,
      ...(r.url ? { url: r.url } : {}),
      fields: fromProperties((r.properties ?? {}) as never),
    })),
    more: Boolean(res.has_more),
  };
}

export async function updateRow(userId: string, source: DataSource, rowId: string, fields: Record<string, string | number | boolean>): Promise<Row> {
  const properties = toProperties(fields, source.properties);
  if (!Object.keys(properties).length) {
    throw new NotionApiError(`Tidak ada kolom yang cocok. Kolom yang ada: ${Object.keys(source.properties).join(", ") || "tidak terbaca"}.`, 400);
  }
  const updated = await callNotion<RawObject>(userId, {
    method: "PATCH",
    path: `/pages/${encodeURIComponent(rowId)}`,
    json: { properties },
  });
  return { id: updated.id, ...(updated.url ? { url: updated.url } : {}), fields: fromProperties((updated.properties ?? {}) as never) };
}
