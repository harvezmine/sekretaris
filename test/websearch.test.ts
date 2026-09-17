import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { runTool, toolsFor } from "../src/agent/tools.ts";
import { webToolDefs } from "../src/agent/webTools.ts";
import { config } from "../src/config.ts";
import type { UserRow } from "../src/db/index.ts";
import { htmlToText, pageTitle, readableText } from "../src/web/html.ts";
import { readPage, searchWeb, SearchError, useWebHttp, webSearchEnabled } from "../src/web/search.ts";
import { tinyPdf } from "./helpers.ts";

const user = { id: "1", waId: "6281", timezone: "Asia/Jakarta", profile: {} } as UserRow;
const PAGE = "https://93.184.216.34/artikel";

interface Call {
  url: URL;
  init: RequestInit;
}

function fakeInternet(routes: (call: Call) => Response | undefined): Call[] {
  const calls: Call[] = [];
  useWebHttp((async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const call = { url, init };
    calls.push(call);
    return routes(call) ?? new Response("tidak ada rute", { status: 500 });
  }) as typeof fetch);
  return calls;
}

const json = (value: unknown, url?: string) =>
  Object.defineProperty(new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }), "url", {
    value: url ?? "",
  });

const page = (body: string | Buffer, type: string, url = PAGE) =>
  Object.defineProperty(new Response(typeof body === "string" ? body : new Uint8Array(body), { headers: { "content-type": type } }), "url", {
    value: url,
  });

afterEach(() => {
  useWebHttp(undefined);
  Object.assign(config, { SEARXNG_URL: "", TAVILY_API_KEY: "", WEB_READ_MAX_CHARS: 12_000, WEB_SEARCH_MAX_RESULTS: 6 });
});

describe("web search", () => {
  test("SearXNG results are mapped, trimmed and capped", async () => {
    config.SEARXNG_URL = "http://searxng:8080/";
    const calls = fakeInternet(({ url }) =>
      url.pathname === "/search"
        ? json({
            results: [
              { title: "  Kurs   rupiah hari ini ", url: "https://www.bi.go.id/kurs", content: "Kurs tengah  USD 16.000", publishedDate: "2026-09-18T04:00:00Z" },
              { title: "", url: "https://kontan.co.id/a", content: "x".repeat(600) },
              { url: undefined, content: "tanpa url" },
            ],
          })
        : undefined,
    );
    const hits = await searchWeb("kurs rupiah", { recent: true, max: 2 });
    assert.deepEqual(hits, [
      { title: "Kurs rupiah hari ini", url: "https://www.bi.go.id/kurs", snippet: "Kurs tengah USD 16.000", source: "bi.go.id", published: "2026-09-18" },
      { title: "kontan.co.id", url: "https://kontan.co.id/a", snippet: "x".repeat(400), source: "kontan.co.id" },
    ]);
    const query = calls[0]!.url.searchParams;
    assert.equal(query.get("q"), "kurs rupiah");
    assert.equal(query.get("format"), "json");
    assert.equal(query.get("time_range"), "month");
    assert.equal(calls[0]!.url.host, "searxng:8080");
  });

  test("Tavily takes over when SearXNG fails or finds nothing", async () => {
    config.SEARXNG_URL = "http://searxng:8080";
    config.TAVILY_API_KEY = "tvly-secret";
    const calls = fakeInternet(({ url }) =>
      url.host === "searxng:8080"
        ? new Response("boom", { status: 502 })
        : json({ results: [{ title: "Berita", url: "https://tempo.co/x", content: "isi", published_date: "2026-09-17" }] }),
    );
    const hits = await searchWeb("banjir jakarta");
    assert.deepEqual(hits.map((h) => [h.source, h.published]), [["tempo.co", "2026-09-17"]]);
    assert.equal(calls[1]!.url.host, "api.tavily.com");
    assert.match(String(new Headers(calls[1]!.init.headers).get("authorization")), /^Bearer tvly-/);
    assert.deepEqual(JSON.parse(String(calls[1]!.init.body)).max_results, 6);

    fakeInternet(({ url }) => (url.host === "searxng:8080" ? json({ results: [] }) : json({ results: [{ title: "T", url: "https://a.id/b" }] })));
    assert.equal((await searchWeb("apa saja"))[0]!.url, "https://a.id/b");
  });

  test("without a working engine the tools say so instead of guessing", async () => {
    assert.equal(webSearchEnabled(), false);
    assert.deepEqual(webToolDefs(), []);
    assert.ok(!toolsFor(user).some((t) => t.name === "web_search"));
    const off = await runTool({ user }, "web_search", { query: "kurs" });
    assert.equal(off.isError, true);
    assert.match(String(off.content), /belum diaktifkan/);

    config.SEARXNG_URL = "http://searxng:8080";
    assert.deepEqual(webToolDefs().map((t) => t.name), ["web_search", "web_read"]);
    assert.ok(toolsFor(user).some((t) => t.name === "web_read"));
    fakeInternet(() => new Response("down", { status: 503 }));
    const broken = await runTool({ user }, "web_search", { query: "kurs" });
    assert.equal(broken.isError, true);
    assert.match(String(broken.content), /Pencarian gagal: pencarian gagal: mesin pencari menjawab HTTP 503/);
    await assert.rejects(searchWeb("  "), (err: Error) => err instanceof SearchError);
  });
});

describe("reading a page", () => {
  test("HTML is reduced to the readable part, with the title", async () => {
    config.SEARXNG_URL = "http://searxng:8080";
    fakeInternet(() =>
      page(
        `<html><head><title>Kurs &amp; Inflasi</title><style>body{}</style></head><body>
         <nav>Beranda Kontak</nav>
         <article><h1>Kurs hari ini</h1><p>Rupiah ditutup di 16.000 per dolar AS.</p><ul><li>BI rate tetap</li><li>Inflasi 2,1%</li></ul></article>
         <footer>Hak cipta 2026</footer><script>track()</script></body></html>`,
        "text/html; charset=utf-8",
      ),
    );
    const result = await readPage(PAGE);
    assert.equal(result.title, "Kurs & Inflasi");
    assert.equal(result.text, "Kurs hari ini\nRupiah ditutup di 16.000 per dolar AS.\n• BI rate tetap\n• Inflasi 2,1%");
    assert.equal(result.truncated, false);
    assert.ok(!result.text.includes("Beranda"), "navigation is dropped");
    assert.ok(!result.text.includes("Hak cipta"), "footer is dropped");
    assert.ok(!result.text.includes("track()"), "scripts are dropped");
  });

  test("plain text and PDF work, other types and big pages are refused", async () => {
    config.SEARXNG_URL = "http://searxng:8080";
    fakeInternet(() => page("baris satu\n\n\n\nbaris dua", "text/plain"));
    assert.equal((await readPage(PAGE)).text, "baris satu\n\nbaris dua");

    fakeInternet(() => page(tinyPdf("Laporan tahunan 2026"), "application/pdf"));
    assert.match((await readPage(PAGE)).text, /Laporan tahunan 2026/);

    fakeInternet(() => page(Buffer.from([0, 1, 2]), "image/png"));
    await assert.rejects(readPage(PAGE), /jenis halaman image\/png belum bisa dibaca/);

    fakeInternet(() => new Response("nope", { status: 404 }));
    await assert.rejects(readPage(PAGE), /halaman menjawab HTTP 404/);

    config.WEB_READ_MAX_CHARS = 1000;
    fakeInternet(() => page("a".repeat(5000), "text/plain"));
    const long = await readPage(PAGE);
    assert.equal(long.text.length, 1000);
    assert.equal(long.truncated, true);
  });

  test("only public addresses are fetched, including after a redirect", async () => {
    config.SEARXNG_URL = "http://searxng:8080";
    const calls = fakeInternet(() => page("<p>ok</p>", "text/html", "https://10.0.0.9/internal"));
    await assert.rejects(readPage("https://10.0.0.9/secret"), /alamat privat/);
    await assert.rejects(readPage("http://127.0.0.1:3000/healthz"), /alamat privat/);
    await assert.rejects(readPage("file:///etc/passwd"), /hanya alamat http atau https/);
    await assert.rejects(readPage("bukan alamat"), /bukan alamat web yang valid/);
    assert.equal(calls.length, 0, "nothing is fetched before the address is checked");

    await assert.rejects(readPage(PAGE), /alamat privat/, "a redirect into the private network is refused too");
    assert.equal(calls.length, 1);
  });

  test("the tools hand the model clean results", async () => {
    config.SEARXNG_URL = "http://searxng:8080";
    fakeInternet(({ url }) =>
      url.pathname === "/search"
        ? json({ results: [{ title: "Kurs BI", url: "https://www.bi.go.id/kurs", content: "16.000" }] })
        : page("<main><p>Kurs tengah hari ini 16.000.</p></main>", "text/html"),
    );
    const found = JSON.parse(String((await runTool({ user }, "web_search", { query: "kurs rupiah" })).content)) as { url: string; source: string }[];
    assert.deepEqual(found, [{ title: "Kurs BI", url: "https://www.bi.go.id/kurs", source: "bi.go.id", snippet: "16.000" }] as never);
    const read = JSON.parse(String((await runTool({ user }, "web_read", { url: PAGE })).content)) as { text: string; url: string };
    assert.equal(read.text, "Kurs tengah hari ini 16.000.");
    assert.equal(read.url, PAGE);
    assert.match(String((await runTool({ user }, "web_read", { url: "https://192.168.1.5/x" })).content), /tidak bisa dibuka/);
  });

  test("html helpers keep structure and decode entities", () => {
    assert.equal(pageTitle("<html><title> Halo &#8212; Milo </title>"), "Halo — Milo");
    assert.equal(pageTitle("<html><body>x</body></html>"), "");
    assert.equal(htmlToText("<p>Satu</p><p>Dua &amp; tiga</p>"), "Satu\nDua & tiga");
    assert.equal(htmlToText("a<br>b<br/>c"), "a\nb\nc");
    assert.equal(readableText("<body><nav>menu</nav><main><p>isi utama</p></main></body>"), "isi utama");
    assert.match(readableText("<body><article>pendek</article><p>Sisanya panjang sekali, jadi artikel pendek tadi diabaikan.</p></body>"), /Sisanya panjang/);
  });
});
