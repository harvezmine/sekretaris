import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { runTool, toolsFor } from "../src/agent/tools.ts";
import { config } from "../src/config.ts";
import { migrate, sql, type UserRow } from "../src/db/index.ts";
import { parseListings, searchMarket, searchUrl } from "../src/market/search.ts";
import { renderedBody, tidyRendered, useRenderHttp } from "../src/web/render.ts";
import { readPage, useWebHttp } from "../src/web/search.ts";
import { readDuration, searchVideos, useYoutubeHttp } from "../src/youtube/search.ts";

const dbEnabled = Boolean(process.env.TEST_DATABASE_URL);

/**
 * Shortened from a real answer for "iphone 15" on Tokopedia: the shape is what the rendering proxy actually
 * emits, images and all, because that shape is the only reason the parser exists.
 */
const TOKOPEDIA = `Title: Jual iphone 15 | Tokopedia

URL Source: https://www.tokopedia.com/search?q=iphone%2015

Markdown Content:
##### Filter

[![Image 1: product-image](https://images.tokopedia.net/a.webp) Soft Case iPhone 15 Pro Max Plus Ringke Air Clear Casing Rp209.000 Hemat s.d 3% Pakai Bonus ![Image 2: rating](https://lf-web-assets.tokopedia-static.net/b.svg) 5.0 50+ terjual ![Image 3: shop badge](https://p16.tokopedia-static.net/c.png) GET-WID Jakarta Barat](https://www.tokopedia.com/get-wid/soft-case-iphone-15-clear-3cfab?extParam=ivf%3Dfalse)

[![Image 4: product-image](https://images.tokopedia.net/d.webp) 39% PROX Tempered Glass For iPhone 15 Pro Max Full Cover Clear Rp116.850 Rp190.000 Bisa COD ![Image 5: rating](https://lf-web-assets.tokopedia-static.net/b.svg) 4,8 30+ terjual ![Image 6: shop badge](https://p16.tokopedia-static.net/c.png) Prox Indonesia Jakarta Barat](https://www.tokopedia.com/proxindonesia/prox-tempered-glass-1731635582542906715)

[![Image 7: product-image](https://images.tokopedia.net/e.webp) iPhone 15 128GB Garansi Resmi iBox Rp11.499.000 ![Image 8: rating](https://lf-web-assets.tokopedia-static.net/b.svg) 5.0 1,2rb terjual ![Image 9: shop badge](https://p16.tokopedia-static.net/c.png) Digimap Official Jakarta Selatan](https://www.tokopedia.com/digimap/iphone-15-128gb-ibox)

[Bantuan Tokopedia](https://www.tokopedia.com/help)

[![Image 10: banner](https://images.tokopedia.net/f.webp)](https://www.tokopedia.com/promo)
`;

describe("reading marketplaces through the rendering proxy", () => {
  test("a listing is a name, a price, a shop and a link, and the noise is dropped", () => {
    const listings = parseListings(TOKOPEDIA);
    assert.equal(listings.length, 3, "the help link and the banner carry no price, so they are not listings");

    assert.deepEqual(listings[0], {
      name: "Soft Case iPhone 15 Pro Max Plus Ringke Air Clear Casing",
      price: 209000,
      shop: "GET-WID Jakarta Barat",
      rating: 5,
      sold: "50+",
      url: "https://www.tokopedia.com/get-wid/soft-case-iphone-15-clear-3cfab?extParam=ivf%3Dfalse",
    });

    const discounted = listings[1]!;
    assert.equal(discounted.price, 116850, "the price paid comes first, the struck-through one second");
    assert.equal(discounted.was, 190000);
    assert.equal(discounted.name, "PROX Tempered Glass For iPhone 15 Pro Max Full Cover Clear", "the discount badge is not part of the name");
    assert.equal(discounted.rating, 4.8, "a comma is how ratings are written here");

    assert.equal(listings[2]!.price, 11499000);
    assert.equal(listings[2]!.sold, "1,2rb");
  });

  test("the search address is built per marketplace, and the proxy preamble is stripped", () => {
    assert.equal(searchUrl("tokopedia", "iphone 15"), "https://www.tokopedia.com/search?q=iphone%2015");
    assert.equal(searchUrl("shopee", "kulkas 2 pintu"), "https://shopee.co.id/search?keyword=kulkas%202%20pintu");
    assert.match(renderedBody(TOKOPEDIA), /^\n*##### Filter/, "Title, URL and warnings are the proxy talking, not the page");
    assert.equal(tidyRendered("![Image 1: x](https://a/b.png) Harga [Toko A](https://a) di sini"), "Harga Toko A di sini");
  });

  test("a marketplace that answers with nothing readable says so instead of inventing a price", async () => {
    useRenderHttp((async () => new Response("Title: Jual x\n\nMarkdown Content:\n\nTidak ada hasil.", { status: 200 })) as typeof fetch);
    const empty = await searchMarket("tokopedia", "barang yang tidak ada");
    assert.deepEqual(empty.listings, []);
    assert.equal(empty.median, undefined);

    useRenderHttp((async () => new Response("Warning: This page maybe requiring CAPTCHA, please make sure", { status: 200 })) as typeof fetch);
    await assert.rejects(searchMarket("tokopedia", "iphone"), /dijaga CAPTCHA/);

    useRenderHttp((async () => new Response("slow down", { status: 429 })) as typeof fetch);
    await assert.rejects(searchMarket("tokopedia", "iphone"), /sedang penuh/);
    useRenderHttp(undefined);
  });
});

describe("finding a video", () => {
  test("a length nobody reads becomes one they do", () => {
    assert.equal(readDuration("PT12M34S"), "12:34");
    assert.equal(readDuration("PT1H2M11S"), "1:02:11");
    assert.equal(readDuration("PT45S"), "0:45");
    assert.equal(readDuration("PT2H"), "2:00:00");
    assert.equal(readDuration("bukan durasi"), undefined);
  });

  test("results carry what makes a list worth reading, and a spent quota says so plainly", async () => {
    const asked: string[] = [];
    useYoutubeHttp((async (input: string | URL | Request) => {
      const url = new URL(String(input));
      asked.push(url.pathname);
      if (url.pathname.endsWith("/search")) {
        return new Response(
          JSON.stringify({
            items: [
              { id: { videoId: "abc12345678" }, snippet: { title: "Cara bikin laporan keuangan UMKM &amp; pajaknya", channelTitle: "Kelas Bisnis", publishedAt: "2026-02-11T09:00:00Z" } },
              { id: { kind: "channel" }, snippet: { title: "sebuah channel" } },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ items: [{ id: "abc12345678", contentDetails: { duration: "PT18M2S" }, statistics: { viewCount: "124500" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch);

    const videos = await searchVideos("laporan keuangan umkm");
    assert.equal(videos.length, 1, "a channel is not a video");
    assert.deepEqual(videos[0], {
      title: "Cara bikin laporan keuangan UMKM & pajaknya",
      channel: "Kelas Bisnis",
      url: "https://www.youtube.com/watch?v=abc12345678",
      published: "2026-02-11",
      length: "18:02",
      views: 124500,
    });
    assert.deepEqual(asked, ["/youtube/v3/search", "/youtube/v3/videos"], "details for every video in one call, not one each");

    useYoutubeHttp((async () =>
      new Response(JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }], message: "quota" } }), { status: 403 })) as typeof fetch);
    await assert.rejects(searchVideos("apa saja"), /Kuota pencarian YouTube hari ini sudah habis/);
    useYoutubeHttp(undefined);
  });
});

describe("the price tool and the reader that falls back", { skip: !dbEnabled && "set TEST_DATABASE_URL to run" }, () => {
  let user: UserRow;

  before(async () => {
    await migrate();
    Object.assign(config, { WEB_RENDER_FALLBACK: true, MARKET_SEARCHES_PER_DAY: 3 });
    await sql`delete from users where wa_id = '6287700000001'`;
    const [row] = await sql<UserRow[]>`
      insert into users (wa_id, status, plan, state, consent_at, trial_ends_at, llm_model)
      values ('6287700000001', 'trialing', 'trial', 'READY', now(), now() + interval '7 days', 'claude-opus-5')
      returning *
    `;
    user = row!;
  });

  after(async () => {
    useRenderHttp(undefined);
    useWebHttp(undefined);
    Object.assign(config, { MARKET_SEARCHES_PER_DAY: 20 });
    await sql`delete from users where id = ${user.id}`;
    await sql.end({ timeout: 5 });
  });

  test("the model gets a range rather than one number, and the daily cap holds", async () => {
    const asked: string[] = [];
    useRenderHttp((async (input: string | URL | Request) => {
      asked.push(String(input));
      return new Response(TOKOPEDIA, { status: 200 });
    }) as typeof fetch);

    const found = JSON.parse(String((await runTool({ user }, "price_check", { query: "iphone 15" })).content)) as {
      cheapest: number;
      dearest: number;
      median: number;
      listings: { name: string }[];
      note: string;
    };
    assert.equal(asked[0], "https://r.jina.ai/https://www.tokopedia.com/search?q=iphone%2015");
    assert.deepEqual([found.cheapest, found.median, found.dearest], [116850, 209000, 11499000]);
    assert.equal(found.listings.length, 3);
    assert.match(found.note, /bukan harga resmi/, "the model is told not to call it the price");
    assert.ok(toolsFor(user).some((t) => t.name === "price_check"));

    await runTool({ user }, "price_check", { query: "kulkas" });
    await runTool({ user }, "price_check", { query: "kipas" });
    const capped = await runTool({ user }, "price_check", { query: "sekali lagi" });
    assert.equal(capped.isError, true);
    assert.match(String(capped.content), /Batas 3 pengecekan harga per hari/);
  });

  test("the video tool appears only with a key, and is capped per user", async () => {
    assert.ok(!toolsFor(user).some((t) => t.name === "youtube_search"), "without a key it does not clutter the prompt");
    assert.match(String((await runTool({ user }, "youtube_search", { query: "apa saja" })).content), /belum diaktifkan/);

    Object.assign(config, { YOUTUBE_API_KEY: "kunci-uji", YOUTUBE_SEARCHES_PER_DAY: 2 });
    useYoutubeHttp((async (input: string | URL | Request) =>
      new Response(
        JSON.stringify(
          String(input).includes("/search")
            ? { items: [{ id: { videoId: "vid00000001" }, snippet: { title: "Notulen rapat otomatis", channelTitle: "Kanal Kerja", publishedAt: "2026-05-02T00:00:00Z" } }] }
            : { items: [{ id: "vid00000001", contentDetails: { duration: "PT7M1S" }, statistics: { viewCount: "980" } }] },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch);
    try {
      assert.ok(toolsFor(user).some((t) => t.name === "youtube_search"));
      const videos = JSON.parse(String((await runTool({ user }, "youtube_search", { query: "notulen rapat" })).content)) as { url: string; length: string }[];
      assert.equal(videos[0]!.url, "https://www.youtube.com/watch?v=vid00000001");
      assert.equal(videos[0]!.length, "7:01");

      await runTool({ user }, "youtube_search", { query: "lagi" });
      const capped = await runTool({ user }, "youtube_search", { query: "sekali lagi" });
      assert.equal(capped.isError, true);
      assert.match(String(capped.content), /Batas 2 pencarian YouTube per hari/);
    } finally {
      Object.assign(config, { YOUTUBE_API_KEY: "", YOUTUBE_SEARCHES_PER_DAY: 5 });
      useYoutubeHttp(undefined);
    }
  });

  test("a page that arrives as an empty shell is read again through the proxy", async () => {
    useWebHttp((async () =>
      new Response("<html><head><title>Toko</title></head><body><div id=root></div></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as typeof fetch);
    let rendered = 0;
    useRenderHttp((async () => {
      rendered++;
      return new Response(`Title: Toko Online\n\nMarkdown Content:\n\n${"Barang bagus dengan harga murah. ".repeat(40)}`, { status: 200 });
    }) as typeof fetch);

    const page = await readPage("https://93.184.216.34/produk");
    assert.equal(rendered, 1);
    assert.equal(page.title, "Toko Online");
    assert.match(page.text, /Barang bagus dengan harga murah/);

    // A page that reads fine directly never reaches the proxy.
    useWebHttp((async () =>
      new Response(`<html><head><title>Artikel</title></head><body><article>${"Isi artikel yang panjang. ".repeat(60)}</article></body></html>`, {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as typeof fetch);
    const article = await readPage("https://93.184.216.34/artikel");
    assert.equal(rendered, 1, "the fallback is for empty pages, not for every page");
    assert.match(article.text, /Isi artikel yang panjang/);

    // And when the proxy fails, the direct read still stands.
    useWebHttp((async () =>
      new Response("<html><head><title>Kosong</title></head><body><p>sedikit</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as typeof fetch);
    useRenderHttp((async () => {
      throw new Error("jaringan putus");
    }) as typeof fetch);
    const thin = await readPage("https://93.184.216.34/lain");
    assert.equal(thin.title, "Kosong");
    assert.match(thin.text, /sedikit/);
  });
});
