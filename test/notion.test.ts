import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { runTool, toolsFor } from "../src/agent/tools.ts";
import { notionToolDefs } from "../src/agent/notionTools.ts";
import { buildApp, type App } from "../src/app.ts";
import { config } from "../src/config.ts";
import { migrate, sql, type UserRow } from "../src/db/index.ts";
import { blocksToText, textToBlocks } from "../src/notion/blocks.ts";
import { toNumber } from "../src/notion/workspace.ts";
import { getNotionAccount, NOTION_VERSION, useNotionHttp } from "../src/notion/client.ts";
import { isInventedMiloLink } from "../src/agent/linkGuard.ts";
import { createSignedToken } from "../src/uploads/links.ts";
import { DryRunClient } from "../src/wa/client.ts";

const dbEnabled = Boolean(process.env.TEST_DATABASE_URL);

interface Call {
  method: string;
  url: URL;
  body: string;
  auth: string;
  version: string;
}

/** Just enough of Notion to drive Milo: OAuth, search, blocks, and one database with two rows. */
class FakeNotion {
  calls: Call[] = [];
  token = "ntn_workspace_token";
  pages: Record<string, { title: string; blocks: Record<string, unknown>[]; parent?: string }> = {};
  databases: Record<string, { title: string; dataSource: string }> = {};
  sources: Record<string, { title: string; properties: Record<string, { type: string }>; rows: Record<string, Record<string, unknown>> }> = {};
  /** Older workspaces answer the database endpoint with 404 and expect the id to be used as a data source. */
  databaseLookupFails = false;

  /** Notion takes properties in one shape and hands them back in another; a fake that skips this proves nothing. */
  private asRead(written: Record<string, Record<string, unknown>>, schema: Record<string, { type: string }>) {
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(written)) {
      const type = schema[name]?.type ?? "rich_text";
      const raw = value[type];
      if (type === "title" || type === "rich_text") {
        const text = ((raw as { text?: { content?: string } }[]) ?? []).map((t) => t.text?.content ?? "").join("");
        out[name] = { type, [type]: [{ plain_text: text }] };
      } else {
        out[name] = { type, [type]: raw };
      }
    }
    return out;
  }

  fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init.method ?? "GET").toUpperCase();
    const body = String(init.body ?? "");
    const headers = new Headers(init.headers);
    this.calls.push({ method, url, body, auth: headers.get("authorization") ?? "", version: headers.get("notion-version") ?? "" });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    const path = url.pathname;

    if (path === "/v1/oauth/token") {
      const basic = Buffer.from((headers.get("authorization") ?? "").replace("Basic ", ""), "base64").toString();
      if (basic !== "cid-notion:secret-notion") return json({ error: "invalid_client" }, 401);
      const sent = JSON.parse(body) as { code: string; redirect_uri: string };
      if (sent.code !== "kode-bagus") return json({ error: "invalid_grant", error_description: "Invalid code" }, 400);
      return json({ access_token: this.token, workspace_id: "ws-1", workspace_name: "Kantor Josh", bot_id: "bot-1" });
    }

    if (headers.get("authorization") !== `Bearer ${this.token}`) return json({ message: "API token is invalid." }, 401);

    if (method === "POST" && path === "/v1/search") {
      const sent = JSON.parse(body) as { query?: string };
      const q = (sent.query ?? "").toLowerCase();
      const hits = [
        ...Object.entries(this.pages).map(([id, p]) => ({
          object: "page",
          id,
          url: `https://notion.so/${id}`,
          properties: { title: { type: "title", title: [{ plain_text: p.title }] } },
        })),
        ...Object.entries(this.databases).map(([id, d]) => ({
          object: "database",
          id,
          url: `https://notion.so/${id}`,
          title: [{ plain_text: d.title }],
        })),
      ].filter((h) => {
        const title = (h.object === "page" ? this.pages[h.id]!.title : this.databases[h.id]!.title).toLowerCase();
        return !q || title.includes(q);
      });
      return json({ results: hits });
    }

    const database = /^\/v1\/databases\/([^/]+)$/.exec(path);
    if (database) {
      if (this.databaseLookupFails) return json({ message: "Could not find database." }, 404);
      const db = this.databases[decodeURIComponent(database[1]!)];
      if (!db) return json({ message: "Could not find database." }, 404);
      return json({ id: database[1], data_sources: [{ id: db.dataSource, name: db.title }] });
    }

    const source = /^\/v1\/data_sources\/([^/]+)$/.exec(path);
    if (source) {
      const ds = this.sources[decodeURIComponent(source[1]!)];
      if (!ds) return json({ message: "Could not find data source." }, 404);
      return json({ id: source[1], title: [{ plain_text: ds.title }], properties: ds.properties });
    }

    const query = /^\/v1\/data_sources\/([^/]+)\/query$/.exec(path);
    if (query && method === "POST") {
      const ds = this.sources[decodeURIComponent(query[1]!)];
      if (!ds) return json({ message: "Could not find data source." }, 404);
      const rows = Object.entries(ds.rows).map(([id, properties]) => ({ id, url: `https://notion.so/${id}`, properties }));
      return json({ results: rows, has_more: false });
    }

    const children = /^\/v1\/blocks\/([^/]+)\/children$/.exec(path);
    if (children) {
      const page = this.pages[decodeURIComponent(children[1]!)];
      if (!page) return json({ message: "Could not find block." }, 404);
      if (method === "PATCH") {
        page.blocks.push(...(JSON.parse(body) as { children: Record<string, unknown>[] }).children);
        return json({ results: [] });
      }
      return json({ results: page.blocks, has_more: false });
    }

    if (method === "POST" && path === "/v1/pages") {
      const sent = JSON.parse(body) as {
        parent: { page_id?: string; data_source_id?: string };
        properties: Record<string, { title?: { text: { content: string } }[] }>;
        children?: Record<string, unknown>[];
      };
      if (sent.parent.data_source_id) {
        const ds = this.sources[sent.parent.data_source_id];
        if (!ds) return json({ message: "Could not find data source." }, 404);
        const id = `row-${Object.keys(ds.rows).length + 1}`;
        ds.rows[id] = this.asRead(sent.properties as never, ds.properties) as never;
        return json({ id, url: `https://notion.so/${id}`, properties: ds.rows[id] });
      }
      const id = `page-${Object.keys(this.pages).length + 1}`;
      this.pages[id] = {
        title: sent.properties.title?.title?.[0]?.text.content ?? "(tanpa judul)",
        blocks: sent.children ?? [],
        ...(sent.parent.page_id ? { parent: sent.parent.page_id } : {}),
      };
      return json({ id, url: `https://notion.so/${id}`, properties: { title: { type: "title", title: [{ plain_text: this.pages[id]!.title }] } } });
    }

    const patch = /^\/v1\/pages\/([^/]+)$/.exec(path);
    if (patch && method === "PATCH") {
      const id = decodeURIComponent(patch[1]!);
      const ds = Object.values(this.sources).find((s) => s.rows[id]);
      if (!ds) return json({ message: "Could not find page." }, 404);
      Object.assign(ds.rows[id]!, this.asRead((JSON.parse(body) as { properties: Record<string, never> }).properties, ds.properties));
      return json({ id, url: `https://notion.so/${id}`, properties: ds.rows[id] });
    }

    return json({ message: `unexpected ${method} ${path}` }, 500);
  }) as typeof fetch;
}

describe("notion, without a database", () => {
  test("what Milo writes becomes real blocks, and what it reads becomes plain text", () => {
    const blocks = textToBlocks("# Rapat vendor\n- harga naik 5%\n- penawaran Jumat\n[ ] kirim revisi\n[x] catat notulen\n1. tindak lanjut\n> kata vendor\nbiasa saja");
    assert.deepEqual(
      blocks.map((b) => b.type),
      ["heading_2", "bulleted_list_item", "bulleted_list_item", "to_do", "to_do", "numbered_list_item", "quote", "paragraph"],
    );
    assert.equal((blocks[3] as { to_do: { checked: boolean } }).to_do.checked, false);
    assert.equal((blocks[4] as { to_do: { checked: boolean } }).to_do.checked, true);
    assert.equal((blocks[0] as { heading_2: { rich_text: { text: { content: string } }[] } }).heading_2.rich_text[0]!.text.content, "Rapat vendor");
    assert.equal(textToBlocks("   ").length, 1, "an empty body still makes a page, not a crash");

    const text = blocksToText([
      { type: "heading_2", heading_2: { rich_text: [{ plain_text: "Keputusan" }] } },
      { type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "harga naik 5%" }] } },
      { type: "to_do", to_do: { rich_text: [{ plain_text: "kirim revisi" }], checked: true } },
      { type: "unsupported_thing", unsupported_thing: {} },
    ]);
    assert.equal(text, "*Keputusan*\n• harga naik 5%\n✅ kirim revisi");
  });

  test("money is read the way people here write it", () => {
    for (const [input, expected] of [
      ["Rp 4.200.000", 4200000],
      ["4.200.000", 4200000],
      ["4,2 juta", 4200000],
      ["1,5jt", 1500000],
      ["500rb", 500000],
      ["2 miliar", 2000000000],
      ["1.000", 1000],
      ["12,5", 12.5],
      ["-750000", -750000],
      ["7", 7],
    ] as const) {
      assert.equal(toNumber(input), expected, input);
    }
    assert.equal(toNumber("belum tahu"), undefined);
    assert.equal(toNumber(""), undefined);
  });

  test("the tools stay hidden until Notion is configured", () => {
    assert.deepEqual(notionToolDefs(), []);
    Object.assign(config, { NOTION_CLIENT_ID: "cid-notion", NOTION_CLIENT_SECRET: "secret-notion" });
    try {
      assert.deepEqual(notionToolDefs().map((t) => t.name).sort(), [
        "notion_db_add",
        "notion_db_read",
        "notion_db_update",
        "notion_note",
        "notion_page_append",
        "notion_page_read",
        "notion_search",
      ]);
    } finally {
      Object.assign(config, { NOTION_CLIENT_ID: "", NOTION_CLIENT_SECRET: "" });
    }
  });
});

describe("notion end to end", { skip: !dbEnabled && "set TEST_DATABASE_URL to run" }, () => {
  const fake = new FakeNotion();
  let ctx: App;
  let wa: DryRunClient;
  let user: UserRow;

  before(async () => {
    await migrate();
    useNotionHttp(fake.fetch);
    Object.assign(config, {
      NOTION_CLIENT_ID: "cid-notion",
      NOTION_CLIENT_SECRET: "secret-notion",
      PUBLIC_BASE_URL: "https://milo.example.com",
    });
    wa = new DryRunClient(`${process.env.DATA_DIR}/dry-run-notion`);
    ctx = await buildApp({ wa, logger: false });
    await sql`delete from users where wa_id = '6285500000001'`;
    const [row] = await sql<UserRow[]>`
      insert into users (wa_id, display_name, status, plan, state, consent_at, trial_ends_at, llm_model)
      values ('6285500000001', 'Josh', 'trialing', 'trial', 'READY', now(), now() + interval '7 days', 'claude-opus-5')
      returning *
    `;
    user = row!;
  });

  after(async () => {
    useNotionHttp(undefined);
    Object.assign(config, { NOTION_CLIENT_ID: "", NOTION_CLIENT_SECRET: "", PUBLIC_BASE_URL: "" });
    await ctx.debouncer.drain();
    await ctx.app.close();
    await sql.end({ timeout: 5 });
  });

  test("the connect page warns about ticking pages, and the callback stores the workspace", async () => {
    const link = `/notion/${createSignedToken("notion", user.id, 1800)}`;
    const page = await ctx.app.inject({ url: link });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /pilih halaman dan database yang boleh diakses/i, "the one thing nobody expects is said before they leave");
    assert.match(String(page.headers["content-security-policy"]), /default-src 'none'/);

    const start = await ctx.app.inject({ url: `${link}/start` });
    assert.equal(start.statusCode, 302);
    const auth = new URL(String(start.headers.location));
    assert.equal(auth.origin + auth.pathname, "https://api.notion.com/v1/oauth/authorize");
    assert.equal(auth.searchParams.get("client_id"), "cid-notion");
    assert.equal(auth.searchParams.get("owner"), "user");
    assert.equal(auth.searchParams.get("redirect_uri"), "https://milo.example.com/notion/callback");
    const state = auth.searchParams.get("state")!;
    assert.ok(state, "the state is what ties the code that comes back to this user");

    // A state is spent the moment it comes back, refused code or not, so a second attempt starts from the link again.
    const bad = await ctx.app.inject({ url: `/notion/callback?state=${state}&code=kode-jelek` });
    assert.equal(bad.statusCode, 502);
    assert.equal(await getNotionAccount(user.id), undefined, "a refused code stores nothing");
    assert.equal(
      (await ctx.app.inject({ url: `/notion/callback?state=${state}&code=kode-bagus` })).statusCode,
      400,
      "and that spent state cannot be rescued by a good code",
    );

    const second = await ctx.app.inject({ url: `${link}/start` });
    const state2 = new URL(String(second.headers.location)).searchParams.get("state")!;
    assert.notEqual(state2, state);
    const good = await ctx.app.inject({ url: `/notion/callback?state=${state2}&code=kode-bagus` });
    assert.equal(good.statusCode, 200);
    assert.match(good.body, /Kantor Josh/);
    const account = (await getNotionAccount(user.id))!;
    assert.equal(account.workspaceName, "Kantor Josh");
    assert.ok(!account.tokenEnc.includes(fake.token), "the token is encrypted at rest");

    const replay = await ctx.app.inject({ url: `/notion/callback?state=${state2}&code=kode-bagus` });
    assert.equal(replay.statusCode, 400, "the same state cannot be used twice");
    assert.ok(fake.calls.every((c) => !c.url.pathname.startsWith("/v1/oauth") || c.version === NOTION_VERSION));

    await ctx.debouncer.drain();
    const told = wa.sent.filter((e) => e.to === user.waId).at(-1)!;
    assert.match(told.text!, /Notion sudah tersambung \(Kantor Josh\)/);
    assert.match(told.text!, /hanya melihat halaman yang Anda centang/i, "the limit is repeated where they will read it");

    assert.equal(isInventedMiloLink(`https://milo.example.com${link}`, "https://milo.example.com"), false, "Milo's own Notion link survives the guard");
    assert.equal(isInventedMiloLink("https://milo.example.com/notion/dibuat-sendiri", "https://milo.example.com"), true);
  });

  test("a note becomes a page, and the page can be read back and added to", async () => {
    fake.pages = { "page-0": { title: "Catatan Kerja", blocks: [] } };
    const made = JSON.parse(
      String((await runTool({ user }, "notion_note", { title: "Notulen Rapat Vendor", body: "# Keputusan\n- harga naik 5%\n[ ] kirim revisi Jumat" })).content),
    ) as { created: string; link: string };
    assert.equal(made.created, "Notulen Rapat Vendor");
    assert.match(made.link, /^https:\/\/notion\.so\/page-/);
    const created = Object.values(fake.pages).find((p) => p.title === "Notulen Rapat Vendor")!;
    assert.equal(created.parent, "page-0", "without a parent named it is filed under a page they shared");
    assert.deepEqual(created.blocks.map((b) => (b as { type: string }).type), ["heading_2", "bulleted_list_item", "to_do"]);

    const read = JSON.parse(String((await runTool({ user }, "notion_page_read", { page: "notulen rapat" })).content)) as { page: string; text: string };
    assert.equal(read.page, "Notulen Rapat Vendor");
    assert.equal(read.text, "*Keputusan*\n• harga naik 5%\n⬜ kirim revisi Jumat");

    const added = JSON.parse(String((await runTool({ user }, "notion_page_append", { page: "notulen rapat", body: "- vendor minta DP 30%" })).content)) as {
      added_lines: number;
    };
    assert.equal(added.added_lines, 1);
    assert.match(String((await runTool({ user }, "notion_page_read", { page: "notulen rapat" })).content), /DP 30%/);

    const missing = await runTool({ user }, "notion_page_append", { page: "halaman yang tidak ada", body: "x" });
    assert.equal(missing.isError, true);
    assert.match(String(missing.content), /Tidak ada halaman Notion berjudul/);
  });

  test("a database row is added, read, and ticked off, whichever id the workspace hands over", async () => {
    fake.databases = { "db-1": { title: "Tugas", dataSource: "ds-1" } };
    fake.sources = {
      "ds-1": {
        title: "Tugas",
        properties: { Nama: { type: "title" }, Status: { type: "select" }, Tenggat: { type: "date" }, Nilai: { type: "number" }, Catatan: { type: "rich_text" } },
        rows: {},
      },
    };

    const added = JSON.parse(
      String(
        (
          await runTool({ user }, "notion_db_add", {
            database: "tugas",
            fields: { Nama: "Kirim penawaran PT Karya", Status: "Belum", Tenggat: "2026-09-25", Nilai: "Rp 4.200.000", Warna: "diabaikan" },
          })
        ).content,
      ),
    ) as { database: string; added: Record<string, string> };
    assert.equal(added.database, "Tugas");
    assert.deepEqual(added.added, {
      Nama: "Kirim penawaran PT Karya",
      Status: "Belum",
      Tenggat: "2026-09-25",
      Nilai: "4200000",
    });

    const read = JSON.parse(String((await runTool({ user }, "notion_db_read", { database: "tugas" })).content)) as {
      columns: string[];
      rows: Record<string, string>[];
    };
    assert.deepEqual(read.columns, ["Nama", "Status", "Tenggat", "Nilai", "Catatan"]);
    assert.equal(read.rows[0]!.Status, "Belum");

    const done = JSON.parse(String((await runTool({ user }, "notion_db_update", { database: "tugas", row: "penawaran", fields: { Status: "Selesai" } })).content)) as {
      updated: Record<string, string>;
    };
    assert.equal(done.updated.Status, "Selesai");
    assert.equal(done.updated.Nama, "Kirim penawaran PT Karya", "the row is recognised by part of its title");

    const nobody = await runTool({ user }, "notion_db_update", { database: "tugas", row: "cuci mobil", fields: { Status: "Selesai" } });
    assert.equal(nobody.isError, true);
    assert.match(String(nobody.content), /Tidak ada baris yang cocok/);

    const wrongColumns = await runTool({ user }, "notion_db_add", { database: "tugas", fields: { Entah: "apa" } });
    assert.equal(wrongColumns.isError, true);
    assert.match(String(wrongColumns.content), /Kolom yang ada: Nama, Status/);

    // A workspace that never migrated answers the database endpoint with 404; the id is the data source itself.
    fake.databaseLookupFails = true;
    fake.sources["db-1"] = fake.sources["ds-1"]!;
    try {
      const still = JSON.parse(String((await runTool({ user }, "notion_db_read", { database: "tugas" })).content)) as { rows: unknown[] };
      assert.equal(still.rows.length, 1, "rows still come back without the data source hop");
    } finally {
      fake.databaseLookupFails = false;
      delete fake.sources["db-1"];
    }
  });

  test("search answers honestly, and a disconnected workspace hands back the link instead of an error", async () => {
    const found = JSON.parse(String((await runTool({ user }, "notion_search", { query: "tugas" })).content)) as { title: string; kind: string }[];
    assert.deepEqual(found, [{ title: "Tugas", kind: "database", link: "https://notion.so/db-1" }]);
    assert.match(
      String((await runTool({ user }, "notion_search", { query: "yang tidak ada" })).content),
      /hanya membaca judul/,
      "it says how the search works rather than implying the workspace was read",
    );
    assert.ok(toolsFor(user).some((t) => t.name === "notion_db_add"));

    await sql`delete from notion_accounts where user_id = ${user.id}`;
    const gone = await runTool({ user }, "notion_db_read", { database: "tugas" });
    assert.equal(gone.isError, true);
    assert.match(String(gone.content), /https:\/\/milo\.example\.com\/notion\/\S+/, "the model is handed a real link to send");
  });
});
