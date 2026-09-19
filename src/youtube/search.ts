import { config } from "../config.js";

/**
 * Finding a video on YouTube, through the official Data API.
 *
 * The free quota is 10,000 units a day for the whole project and one search costs 100 of them, so the ceiling is
 * a hundred searches a day shared by every user. That is why a search is capped per user and why the details of
 * each video are fetched in one extra call costing a single unit rather than one call per video.
 */

const API = "https://www.googleapis.com/youtube/v3";

type Fetch = typeof fetch;
let http: Fetch = (input, init) => fetch(input, init);

/** Tests swap in a fake YouTube. */
export function useYoutubeHttp(fn: Fetch | undefined): void {
  http = fn ?? ((input, init) => fetch(input, init));
}

export function youtubeEnabled(): boolean {
  return Boolean(config.YOUTUBE_API_KEY);
}

export class YoutubeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YoutubeError";
  }
}

export interface Video {
  title: string;
  channel: string;
  url: string;
  published: string;
  /** "12:34", or "1:02:11" for the long ones. */
  length?: string;
  views?: number;
}

/** "PT1H2M11S" is how YouTube states a length; nobody reads it that way. */
export function readDuration(iso: string): string | undefined {
  const m = /^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso.trim());
  if (!m) return undefined;
  const [h, min, sec] = [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)];
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(min)}:${pad(sec)}` : `${min}:${pad(sec)}`;
}

interface SearchResponse {
  items?: { id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string; publishedAt?: string } }[];
  error?: { message?: string; errors?: { reason?: string }[] };
}

interface DetailResponse {
  items?: { id?: string; contentDetails?: { duration?: string }; statistics?: { viewCount?: string } }[];
}

async function call<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries({ ...params, key: config.YOUTUBE_API_KEY })) url.searchParams.set(k, v);
  const res = await http(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  const body = (await res.json().catch(() => ({}))) as SearchResponse;
  if (!res.ok) {
    const reason = body.error?.errors?.[0]?.reason ?? "";
    if (reason === "quotaExceeded" || res.status === 403) {
      throw new YoutubeError("Kuota pencarian YouTube hari ini sudah habis. Coba lagi besok.");
    }
    throw new YoutubeError(body.error?.message ?? `YouTube menjawab HTTP ${res.status}`);
  }
  return body as T;
}

/** Newest first is rarely what someone wants; relevance is, so that is what is asked for. */
export async function searchVideos(query: string, max = 5): Promise<Video[]> {
  if (!query.trim()) throw new YoutubeError("Sebutkan yang ingin dicari di YouTube.");
  const found = await call<SearchResponse>("search", {
    part: "snippet",
    type: "video",
    q: query.trim(),
    maxResults: String(Math.min(Math.max(max, 1), 10)),
    regionCode: "ID",
    relevanceLanguage: "id",
    order: "relevance",
  });

  const items = (found.items ?? []).filter((i) => i.id?.videoId);
  if (!items.length) return [];

  // One more call for every video at once: length and views are what make a list of titles worth reading.
  const ids = items.map((i) => i.id!.videoId!).join(",");
  const details = await call<DetailResponse>("videos", { part: "contentDetails,statistics", id: ids }).catch(() => ({}) as DetailResponse);
  const byId = new Map((details.items ?? []).map((d) => [d.id, d]));

  return items.map((item) => {
    const id = item.id!.videoId!;
    const extra = byId.get(id);
    const length = extra?.contentDetails?.duration ? readDuration(extra.contentDetails.duration) : undefined;
    const views = Number(extra?.statistics?.viewCount ?? "");
    return {
      title: (item.snippet?.title ?? "(tanpa judul)").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
      channel: item.snippet?.channelTitle ?? "",
      url: `https://www.youtube.com/watch?v=${id}`,
      published: (item.snippet?.publishedAt ?? "").slice(0, 10),
      ...(length ? { length } : {}),
      ...(Number.isFinite(views) && views > 0 ? { views } : {}),
    };
  });
}
