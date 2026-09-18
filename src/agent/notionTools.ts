import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  getNotionAccount,
  NotionApiError,
  NotionNotConnectedError,
  NotionNotSharedError,
  notionEnabled,
} from "../notion/client.js";
import { notionUrlFor, NOTION_CONNECT_MINUTES } from "../notion/connect.js";
import {
  addRow,
  appendToPage,
  createPage,
  dataSourceOf,
  findOne,
  queryRows,
  readPage,
  search,
  updateRow,
} from "../notion/workspace.js";
import type { ToolContext, ToolOutcome } from "./tools.js";

type BetaTool = Anthropic.Beta.BetaTool;

const ok = (value: unknown): ToolOutcome => ({ content: typeof value === "string" ? value : JSON.stringify(value) });
const fail = (message: string): ToolOutcome => ({ content: message, isError: true });

/** Said once here, because every tool has the same two ways of failing. */
async function guard(userId: string, run: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof NotionNotConnectedError) {
      const url = notionUrlFor(userId);
      return fail(
        url
          ? `Notion belum terhubung. Kirim link ini ke pengguna apa adanya dan katakan berlaku ${NOTION_CONNECT_MINUTES} menit: ${url}`
          : "Notion belum terhubung, dan link untuk menghubungkannya belum bisa dibuat.",
      );
    }
    if (err instanceof NotionNotSharedError) {
      return fail(`${err.message} Minta pengguna membukanya di Notion lalu memilih Connections, atau sebut halaman lain yang sudah dibagikan.`);
    }
    if (err instanceof NotionApiError) return fail(`Notion menolak: ${err.message}`);
    throw err;
  }
}

const DEFS: BetaTool[] = [
  {
    name: "notion_search",
    description: [
      "Find pages and databases in the user's Notion. Leave query empty to list what they shared with you, which is the honest answer to \"kamu bisa lihat apa di Notion?\".",
      "Notion matches titles, not the words inside a page. When nothing comes back, say that you searched their titles rather than implying their whole workspace was read, and ask for the name they gave it.",
    ].join("\n\n"),
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Part of the title. Empty lists the most recently edited." },
        kind: { type: "string", enum: ["page", "database"], description: "Narrow it when you know which one you need." },
      },
    },
  },
  {
    name: "notion_note",
    description: [
      "Write a new page in Notion: meeting notes, a summary, a draft. Give the body the way you write for WhatsApp; \"# \" headings, \"- \" bullets, \"1. \" numbers and \"[ ] \" checkboxes all become real Notion blocks.",
      "Name the page the way the user would look for it later. Put it under a page with parent when they say where; otherwise it is filed under the page they shared most recently. Send back the link in one short line.",
    ].join("\n\n"),
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string", description: "The content, one thought per line." },
        parent: { type: "string", description: "Title of the page it belongs under, when the user named one." },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "notion_page_read",
    description:
      "Read a page in Notion and answer from it: an SOP, a note from a past meeting, a brief. Give the page roughly by its title. Say which page the answer came from, and never claim to have read a page this did not return.",
    input_schema: { type: "object", properties: { page: { type: "string" } }, required: ["page"] },
  },
  {
    name: "notion_page_append",
    description:
      "Add lines to the end of a page that already exists, for when the user remembers something after the fact: \"tambahkan ke catatan rapat kemarin, vendor minta DP 30%\". Same writing rules as notion_note.",
    input_schema: {
      type: "object",
      properties: { page: { type: "string" }, body: { type: "string" } },
      required: ["page", "body"],
    },
  },
  {
    name: "notion_db_add",
    description: [
      "Add one row to one of the user's Notion databases: a task, an order, a client, an expense. Give the database by name and the columns as fields, e.g. {\"Nama\": \"PT Karya\", \"Tenggat\": \"2026-09-25\", \"Status\": \"Belum\"}.",
      "Use the column names the database already has; a name it does not have is skipped and the answer tells you which columns exist. Dates go in as YYYY-MM-DD, amounts as plain numbers.",
    ].join("\n\n"),
    input_schema: {
      type: "object",
      properties: {
        database: { type: "string" },
        fields: { type: "object", description: "Column name to value." },
      },
      required: ["database", "fields"],
    },
  },
  {
    name: "notion_db_read",
    description:
      "Read recent rows of a database so you can count, total or summarise them: \"tugas yang belum selesai\", \"pesanan minggu ini\". Answer with the numbers that matter, not every row.",
    input_schema: {
      type: "object",
      properties: { database: { type: "string" }, limit: { type: "integer", description: "1-50, default 20." } },
      required: ["database"],
    },
  },
  {
    name: "notion_db_update",
    description:
      "Change one row that already exists, which is how a task gets ticked off: give the database, enough of the row's title to recognise it, and the columns to change, e.g. {\"Status\": \"Selesai\"}. Say which row you changed so the user can correct you.",
    input_schema: {
      type: "object",
      properties: {
        database: { type: "string" },
        row: { type: "string", description: "Part of the row's title." },
        fields: { type: "object" },
      },
      required: ["database", "row", "fields"],
    },
  },
];

export function notionToolDefs(): BetaTool[] {
  return notionEnabled() ? DEFS : [];
}

const fieldValue = z.union([z.string().max(2000), z.number(), z.boolean()]);

export const notionInputs = {
  notion_search: z.object({ query: z.string().max(200).optional(), kind: z.enum(["page", "database"]).optional() }),
  notion_note: z.object({ title: z.string().min(1).max(200), body: z.string().min(1).max(20000), parent: z.string().max(200).optional() }),
  notion_page_read: z.object({ page: z.string().min(1).max(200) }),
  notion_page_append: z.object({ page: z.string().min(1).max(200), body: z.string().min(1).max(20000) }),
  notion_db_add: z.object({ database: z.string().min(1).max(200), fields: z.record(z.string().max(100), fieldValue) }),
  notion_db_read: z.object({ database: z.string().min(1).max(200), limit: z.coerce.number().int().optional() }),
  notion_db_update: z.object({
    database: z.string().min(1).max(200),
    row: z.string().min(1).max(200),
    fields: z.record(z.string().max(100), fieldValue),
  }),
} as const;

type NotionToolName = keyof typeof notionInputs;

/** Everything row-shaped starts here: the database the user named, resolved to the data source holding the rows. */
async function source(userId: string, name: string) {
  const found = await findOne(userId, name, "database");
  if (!found) return undefined;
  return { found, source: await dataSourceOf(userId, found.id, found.title) };
}

export const notionHandlers: {
  [K in NotionToolName]: (ctx: ToolContext, input: z.infer<(typeof notionInputs)[K]>) => Promise<ToolOutcome>;
} = {
  async notion_search({ user }, { query, kind }) {
    return guard(user.id, async () => {
      const hits = await search(user.id, query ?? "", kind);
      if (!hits.length) {
        const account = await getNotionAccount(user.id);
        return ok(
          account
            ? "Tidak ada yang cocok. Pencarian Notion hanya membaca judul, jadi mungkin namanya berbeda, atau halamannya belum dibagikan ke Milo."
            : "Notion belum terhubung.",
        );
      }
      return ok(hits.map((h) => ({ title: h.title, kind: h.kind, ...(h.url ? { link: h.url } : {}) })));
    });
  },

  async notion_note({ user }, { title, body, parent }) {
    return guard(user.id, async () => {
      const under = parent ? await findOne(user.id, parent, "page") : undefined;
      if (parent && !under) return fail(`Tidak ada halaman Notion bernama "${parent}". Cek dengan notion_search, atau tulis tanpa parent.`);
      const page = await createPage(user.id, { title, body, ...(under ? { parentId: under.id } : {}) });
      return ok({ created: page.title, ...(page.url ? { link: page.url } : {}), ...(under ? { under: under.title } : {}) });
    });
  },

  async notion_page_read({ user }, { page }) {
    return guard(user.id, async () => {
      const found = await findOne(user.id, page, "page");
      if (!found) return ok(`Tidak ada halaman Notion berjudul "${page}". Pencariannya berdasarkan judul, jadi minta nama yang lebih tepat.`);
      const read = await readPage(user.id, found.id, found.title);
      if (!read.text) return ok({ page: found.title, text: "(halaman ini kosong)", ...(found.url ? { link: found.url } : {}) });
      return ok({ page: found.title, text: read.text, ...(read.truncated ? { note: "Baru sebagian; halamannya panjang." } : {}), ...(found.url ? { link: found.url } : {}) });
    });
  },

  async notion_page_append({ user }, { page, body }) {
    return guard(user.id, async () => {
      const found = await findOne(user.id, page, "page");
      if (!found) return fail(`Tidak ada halaman Notion berjudul "${page}". Cek dengan notion_search.`);
      const added = await appendToPage(user.id, found.id, body);
      return ok({ page: found.title, added_lines: added, ...(found.url ? { link: found.url } : {}) });
    });
  },

  async notion_db_add({ user }, { database, fields }) {
    return guard(user.id, async () => {
      const resolved = await source(user.id, database);
      if (!resolved) return fail(`Tidak ada database Notion bernama "${database}". Lihat yang ada dengan notion_search.`);
      const row = await addRow(user.id, resolved.source, fields);
      return ok({ database: resolved.source.title, added: row.fields, ...(row.url ? { link: row.url } : {}) });
    });
  },

  async notion_db_read({ user }, { database, limit }) {
    return guard(user.id, async () => {
      const resolved = await source(user.id, database);
      if (!resolved) return fail(`Tidak ada database Notion bernama "${database}". Lihat yang ada dengan notion_search.`);
      const { rows, more } = await queryRows(user.id, resolved.source, limit ?? 20);
      if (!rows.length) return ok(`Database "${resolved.source.title}" masih kosong.`);
      return ok({
        database: resolved.source.title,
        columns: Object.keys(resolved.source.properties),
        rows: rows.map((r) => r.fields),
        ...(more ? { note: "Masih ada baris lain yang belum diambil." } : {}),
      });
    });
  },

  async notion_db_update({ user }, { database, row, fields }) {
    return guard(user.id, async () => {
      const resolved = await source(user.id, database);
      if (!resolved) return fail(`Tidak ada database Notion bernama "${database}". Lihat yang ada dengan notion_search.`);
      const { rows } = await queryRows(user.id, resolved.source, 50);
      const wanted = row.trim().toLowerCase();
      const titleOfRow = (r: (typeof rows)[number]) => Object.values(r.fields)[0]?.toLowerCase() ?? "";
      const hit =
        rows.find((r) => titleOfRow(r) === wanted) ??
        rows.find((r) => titleOfRow(r).includes(wanted)) ??
        rows.find((r) => Object.values(r.fields).some((v) => v.toLowerCase().includes(wanted)));
      if (!hit) return fail(`Tidak ada baris yang cocok dengan "${row}" di "${resolved.source.title}". Lihat isinya dulu dengan notion_db_read.`);
      const updated = await updateRow(user.id, resolved.source, hit.id, fields);
      return ok({ database: resolved.source.title, updated: updated.fields, ...(updated.url ? { link: updated.url } : {}) });
    });
  },
};
