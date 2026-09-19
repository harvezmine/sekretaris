import { extractTextFrom } from "../capture/extract.js";
import { config } from "../config.js";
import { resolvePublicHost, type AddressPolicy } from "../servers/keys.js";
import { htmlToText, pageTitle, readableText } from "./html.js";
import { renderEnabled, renderPage, THIN_PAGE_CHARS, tidyRendered } from "./render.js";

/**
 * Live web access for the model: a search through the operator's own SearXNG (or Tavily as a fallback) and a
 * reader that turns one page into plain text. Pages are fetched by Milo's server, so only public addresses are
 * allowed and every response is capped in size and time.
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  source: string;
  published?: string;
}

export interface PageText {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

export class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchError";
  }
}

type Fetch = typeof fetch;
let http: Fetch = (input, init) => fetch(input, init);

/** Tests swap in a fake internet. */
export function useWebHttp(fn: Fetch | undefined): void {
  http = fn ?? ((input, init) => fetch(input, init));
}

export function webSearchEnabled(): boolean {
  return Boolean(config.SEARXNG_URL || config.TAVILY_API_KEY);
}

const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

interface SearxngResponse {
  results?: { title?: string; url?: string; content?: string; engine?: string; publishedDate?: string | null }[];
}

async function searchSearxng(query: string, max: number, recent: boolean): Promise<SearchHit[]> {
  const url = new URL(`${config.SEARXNG_URL.replace(/\/+$/, "")}/search`);
  url.search = new URLSearchParams({
    q: query,
    format: "json",
    language: "id",
    safesearch: "0",
    categories: "general",
    ...(recent ? { time_range: "month" } : {}),
  }).toString();
  const res = await http(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new SearchError(`mesin pencari menjawab HTTP ${res.status}`);
  const json = (await res.json()) as SearxngResponse;
  return (json.results ?? [])
    .filter((r) => r.url)
    .slice(0, max)
    .map((r) => ({
      title: clean(r.title ?? "") || hostOf(r.url!),
      url: r.url!,
      snippet: clean(r.content ?? "").slice(0, 400),
      source: hostOf(r.url!),
      ...(r.publishedDate ? { published: r.publishedDate.slice(0, 10) } : {}),
    }));
}

async function searchTavily(query: string, max: number, recent: boolean): Promise<SearchHit[]> {
  const res = await http("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.TAVILY_API_KEY}` },
    body: JSON.stringify({ query, max_results: max, search_depth: "basic", ...(recent ? { days: 30 } : {}) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new SearchError(`Tavily menjawab HTTP ${res.status}`);
  const json = (await res.json()) as { results?: { title?: string; url?: string; content?: string; published_date?: string }[] };
  return (json.results ?? [])
    .filter((r) => r.url)
    .slice(0, max)
    .map((r) => ({
      title: clean(r.title ?? "") || hostOf(r.url!),
      url: r.url!,
      snippet: clean(r.content ?? "").slice(0, 400),
      source: hostOf(r.url!),
      ...(r.published_date ? { published: r.published_date.slice(0, 10) } : {}),
    }));
}

/** SearXNG first; Tavily catches the case where the self-hosted engines are rate-limited or down. */
export async function searchWeb(query: string, opts: { max?: number; recent?: boolean } = {}): Promise<SearchHit[]> {
  const text = query.trim();
  if (!text) throw new SearchError("kata kunci pencarian kosong");
  const max = Math.min(Math.max(opts.max ?? config.WEB_SEARCH_MAX_RESULTS, 1), 20);
  const recent = opts.recent ?? false;
  let firstError: unknown;
  if (config.SEARXNG_URL) {
    try {
      const hits = await searchSearxng(text, max, recent);
      if (hits.length || !config.TAVILY_API_KEY) return hits;
    } catch (err) {
      firstError = err;
    }
  }
  if (config.TAVILY_API_KEY) return searchTavily(text, max, recent);
  if (firstError) throw new SearchError(`pencarian gagal: ${firstError instanceof Error ? firstError.message : String(firstError)}`);
  throw new SearchError("pencarian internet belum diaktifkan");
}

export async function readPage(raw: string, policy?: AddressPolicy): Promise<PageText> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SearchError(`"${raw}" bukan alamat web yang valid`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SearchError("hanya alamat http atau https");
  await resolvePublicHost(url.hostname, policy);

  const res = await http(url, {
    headers: { accept: "text/html,text/plain,application/pdf;q=0.9,*/*;q=0.1", "user-agent": "MiloBot/1.0 (+asisten WhatsApp)" },
    signal: AbortSignal.timeout(20_000),
    redirect: "follow",
  });
  if (!res.ok) throw new SearchError(`halaman menjawab HTTP ${res.status}`);
  if (res.url && res.url !== url.toString()) await resolvePublicHost(new URL(res.url).hostname, policy);

  const type = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "text/html";
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_PAGE_BYTES) throw new SearchError("halaman terlalu besar untuk dibaca");

  let title = "";
  let text: string;
  if (type === "text/html" || type === "application/xhtml+xml") {
    const html = buffer.toString("utf8");
    title = pageTitle(html);
    text = readableText(html);
  } else if (type.startsWith("text/")) {
    text = htmlToText(buffer.toString("utf8"));
  } else if (type === "application/pdf") {
    const extracted = await extractTextFrom(buffer, type);
    if (!extracted.text) throw new SearchError(extracted.note ?? "isi PDF tidak bisa dibaca");
    text = extracted.text;
  } else {
    throw new SearchError(`jenis halaman ${type} belum bisa dibaca`);
  }

  const limit = config.WEB_READ_MAX_CHARS;
  // A page drawn entirely by JavaScript answers a plain fetch with a shell. Rather than tell the user the page is
  // empty when their browser shows a full one, it is read once more through the rendering proxy.
  if (text.trim().length < THIN_PAGE_CHARS && renderEnabled()) {
    try {
      const rendered = await renderPage(res.url || url.toString());
      const drawn = tidyRendered(rendered.text);
      if (drawn.length > text.trim().length) {
        title = rendered.title || title;
        text = drawn;
      }
    } catch {
      // The direct read stands; a fallback that fails changes nothing.
    }
  }
  return {
    url: res.url || url.toString(),
    title: title || hostOf(res.url || url.toString()),
    text: text.slice(0, limit),
    truncated: text.length > limit,
  };
}
