import { renderPage, renderedBody, RenderError } from "../web/render.js";

/**
 * What something costs right now in the marketplaces people here actually buy from.
 *
 * Neither Tokopedia nor Shopee opens an API for this, and their pages answer a plain fetch with an empty shell, so
 * the listings are read through the rendering proxy the web reader falls back on. That makes this a scraper at one
 * remove: it can break the day a marketplace changes its markup, and it is written to fail loudly rather than to
 * invent a price. No account and no cookie of the user's is ever involved.
 */

export type Marketplace = "tokopedia" | "shopee";

export interface Listing {
  name: string;
  price: number;
  /** Struck-through price, when the listing shows one. */
  was?: number;
  shop?: string;
  city?: string;
  rating?: number;
  sold?: string;
  url?: string;
}

export interface MarketResult {
  marketplace: Marketplace;
  query: string;
  listings: Listing[];
  /** What the user should be told the numbers are: the middle of the range, not "the price". */
  median?: number;
}

export class MarketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketError";
  }
}

export function searchUrl(marketplace: Marketplace, query: string): string {
  const q = encodeURIComponent(query.trim());
  return marketplace === "shopee" ? `https://shopee.co.id/search?keyword=${q}` : `https://www.tokopedia.com/search?q=${q}`;
}

/** "Rp4.200.000" and "Rp 65.000": dots group thousands here, so they come out before the number is read. */
function rupiah(text: string): number | undefined {
  const digits = text.replace(/[^\d]/g, "");
  if (!digits) return undefined;
  const value = Number(digits);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

const PRICE = /Rp\s?\d[\d.]{2,}/g;
const RATING = /\b([1-5][.,]\d)\b/;
const SOLD = /(\d+[.,]?\d*\+?\s*(?:rb|ribu|jt)?)\s*terjual/i;

/**
 * One listing per markdown link. The proxy emits each product as "[name Rp123.456 … shop city](url)", so the link
 * is the unit, and everything else is read out of it positionally: the name runs up to the first price.
 */
export function parseListings(markdown: string, max = 8): Listing[] {
  // Images come out first: a listing wraps its thumbnail, and a nested "![alt](src)" hides the link's own brackets.
  const body = renderedBody(markdown).replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  const listings: Listing[] = [];

  for (const match of body.matchAll(/\[([^\][]{10,800})\]\((https?:\/\/[^)\s]+)\)/g)) {
    const inner = match[1]!.replace(/\s+/g, " ").trim();
    const url = match[2]!;
    const prices = [...inner.matchAll(PRICE)].map((p) => p[0]);
    if (!prices.length) continue;

    const price = rupiah(prices[0]!);
    if (price === undefined) continue;
    const firstPriceAt = inner.indexOf(prices[0]!);
    const name = inner
      .slice(0, firstPriceAt)
      .replace(/^\s*\d+%\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (name.length < 3) continue;

    const after = inner.slice(firstPriceAt + prices[0]!.length);
    const was = prices[1] ? rupiah(prices[1]) : undefined;
    // What trails the counts is the shop and its city, which is the only place either appears.
    const tail = after.split(/terjual/i).at(-1)?.replace(/\s+/g, " ").trim() ?? "";
    const rating = RATING.exec(after)?.[1]?.replace(",", ".");
    const sold = SOLD.exec(after)?.[1]?.trim();

    listings.push({
      name: name.slice(0, 140),
      price,
      ...(was && was > price ? { was } : {}),
      ...(tail ? { shop: tail.slice(0, 80) } : {}),
      ...(rating ? { rating: Number(rating) } : {}),
      ...(sold ? { sold } : {}),
      url,
    });
    if (listings.length >= max) break;
  }
  return listings;
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export async function searchMarket(marketplace: Marketplace, query: string, max = 8): Promise<MarketResult> {
  if (!query.trim()) throw new MarketError("Sebutkan barang yang ingin dicek harganya.");
  const url = searchUrl(marketplace, query);
  let markdown: string;
  try {
    markdown = (await renderPage(url)).text;
  } catch (err) {
    if (err instanceof RenderError) throw new MarketError(err.message);
    throw err;
  }
  const listings = parseListings(markdown, max);
  return {
    marketplace,
    query: query.trim(),
    listings,
    ...(listings.length ? { median: median(listings.map((l) => l.price)) } : {}),
  };
}
