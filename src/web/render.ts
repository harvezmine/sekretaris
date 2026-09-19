import { config } from "../config.js";

/**
 * A page that arrives empty because its contents are drawn by JavaScript, read through a rendering proxy instead.
 *
 * Milo's own reader fetches raw HTML, which is the right default: it is direct, fast, and nothing leaves the server
 * but the request itself. Marketplaces and other single-page apps answer that with a shell and no words, and for
 * those this is the fallback. It is a third party, so it is used only when the direct read came back with nothing
 * worth reading, and the address is the only thing handed over.
 */

const READER = "https://r.jina.ai/";
/** Below this a "page" is a loading screen, a cookie wall, or an error, not something a person could read. */
export const THIN_PAGE_CHARS = 600;
/** The proxy returns before the page finished drawing unless it is told to wait; a marketplace needs the wait. */
const RENDER_WAIT_SECONDS = 25;

type Fetch = typeof fetch;
let http: Fetch = (input, init) => fetch(input, init);

/** Tests swap in a fake reader. */
export function useRenderHttp(fn: Fetch | undefined): void {
  http = fn ?? ((input, init) => fetch(input, init));
}

export function renderEnabled(): boolean {
  return config.WEB_RENDER_FALLBACK;
}

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderError";
  }
}

export interface Rendered {
  title: string;
  text: string;
}

/** Strips the markdown images and link targets the proxy emits, which are noise once the text is what matters. */
export function tidyRendered(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\((https?:[^)]*)\)/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function headerValue(markdown: string, label: string): string {
  return new RegExp(`^${label}:\\s*(.+)$`, "m").exec(markdown)?.[1]?.trim() ?? "";
}

/** The markdown body, with the proxy's own Title/URL/Warning preamble removed. */
export function renderedBody(markdown: string): string {
  const marker = markdown.indexOf("Markdown Content:");
  return marker === -1 ? markdown : markdown.slice(marker + "Markdown Content:".length);
}

export async function renderPage(url: string): Promise<Rendered> {
  const res = await http(`${READER}${url}`, {
    headers: {
      accept: "text/plain",
      "x-timeout": String(RENDER_WAIT_SECONDS),
      "x-retain-images": "none",
      ...(config.JINA_API_KEY ? { authorization: `Bearer ${config.JINA_API_KEY}` } : {}),
    },
    signal: AbortSignal.timeout((RENDER_WAIT_SECONDS + 20) * 1000),
  });
  if (!res.ok) {
    throw new RenderError(res.status === 429 ? "pembaca halaman sedang penuh, coba lagi sebentar lagi" : `pembaca halaman menjawab HTTP ${res.status}`);
  }
  const markdown = await res.text();
  if (/requiring CAPTCHA/i.test(markdown)) throw new RenderError("halaman itu dijaga CAPTCHA, jadi isinya tidak bisa dibaca");
  return { title: headerValue(markdown, "Title"), text: renderedBody(markdown) };
}
