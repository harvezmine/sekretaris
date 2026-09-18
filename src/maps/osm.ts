import { config } from "../config.js";
import type { PlaceHit } from "./places.js";

/**
 * The free way to answer "yang terdekat": OpenStreetMap, through Overpass for places and Nominatim for turning an
 * area name into a point. No key, no bill.
 *
 * What it cannot do is tell you which restaurant is good — OSM has no ratings. It knows what is there and where,
 * which is exactly right for a petrol station, an ATM or a pharmacy, and only half the answer for dinner.
 *
 * Both services are donated infrastructure with a usage policy: one request at a time, an honest User-Agent, and
 * no bulk scraping. The throttle below keeps Milo inside it.
 */

export interface OsmQuery {
  keyword: string;
  lat: number;
  lng: number;
  radius?: number | undefined;
  max?: number | undefined;
  /** The keyword is one place's name, not a category: match on the name and rank by how well it fits. */
  byName?: boolean | undefined;
}

export class OsmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OsmError";
  }
}

type Fetch = typeof fetch;
let http: Fetch = (input, init) => fetch(input, init);

/** Tests swap in a fake OpenStreetMap. */
export function useOsmHttp(fn: Fetch | undefined): void {
  http = fn ?? ((input, init) => fetch(input, init));
}

const AGENT = "MiloBot/1.0 (asisten WhatsApp; +https://github.com/harvezmine/sekretaris)";
const MIN_GAP_MS = 1100;
let lastCall = 0;

/** One request at a time, at most one per second: the public instances ask for exactly this. */
async function polite<T>(fn: () => Promise<T>): Promise<T> {
  const wait = Math.max(0, lastCall + MIN_GAP_MS - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  return fn();
}

/**
 * What people actually type, mapped to the OSM tags that hold it. The order matters: the first match wins, so
 * "pom bensin" is fuel before "pom" can match anything else.
 */
const TAGS: [RegExp, string][] = [
  [/\b(spbu|pom bensin|bensin|pertamina|shell|bbm|isi bensin)\b/i, '["amenity"="fuel"]'],
  [/\b(atm|tarik tunai)\b/i, '["amenity"="atm"]'],
  [/\b(bank)\b/i, '["amenity"="bank"]'],
  [/\b(apotek|apotik|farmasi)\b/i, '["amenity"="pharmacy"]'],
  [/\b(rumah sakit|rs|igd)\b/i, '["amenity"="hospital"]'],
  [/\b(klinik|puskesmas|dokter)\b/i, '["amenity"="clinic"]'],
  [/\b(kafe|cafe|kopi|coffee|ngopi)\b/i, '["amenity"="cafe"]'],
  [/\b(restoran|resto|makan|makanan|warung|rumah makan|kuliner|nasi|bakso|sate|padang)\b/i, '["amenity"="restaurant"]'],
  [/\b(hotel|penginapan|menginap)\b/i, '["tourism"="hotel"]'],
  [/\b(minimarket|indomaret|alfamart|supermarket|belanja)\b/i, '["shop"~"convenience|supermarket"]'],
  [/\b(bengkel|servis motor|servis mobil|tambal ban)\b/i, '["shop"~"car_repair|motorcycle_repair"]'],
  [/\b(masjid|musholla|sholat)\b/i, '["amenity"="place_of_worship"]["religion"="muslim"]'],
  [/\b(gereja)\b/i, '["amenity"="place_of_worship"]["religion"="christian"]'],
  [/\b(parkir)\b/i, '["amenity"="parking"]'],
  [/\b(mall|mal|plaza|pusat perbelanjaan)\b/i, '["shop"="mall"]'],
  [/\b(toilet|wc)\b/i, '["amenity"="toilets"]'],
  [/\b(polisi|polsek|polres)\b/i, '["amenity"="police"]'],
];

/** Overpass strings are quoted; a stray quote or backslash would end the filter early. */
function literal(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * A category filter when the words name a kind of place, a name filter otherwise. byName forces the name branch,
 * because "Warung Sunda Asri" is a name that happens to contain a category word: matching it as a category would
 * return the nearest warung, which is a different restaurant.
 */
export function osmFilter(keyword: string, byName = false): string {
  const tag = byName ? undefined : TAGS.find(([re]) => re.test(keyword))?.[1];
  if (tag) return tag;
  const words = keyword
    .replace(/\b(terdekat|dekat|sini|sekitar|yang|enak|murah|bagus|buka|sekarang|di|ke)\b/gi, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 3);
  return words.length ? `["name"~"${literal(words.join("|"))}",i]` : '["amenity"]';
}

/**
 * How well a place's name answers the words that were searched for. Used only when the keyword was a name rather
 * than a category: asked for "Warung Sunda Asri", the closest warung is the wrong answer if it is a different one.
 */
export function nameScore(query: string, name: string): number {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
  if (!words.length) return 0;
  const lower = name.toLowerCase();
  return words.filter((w) => lower.includes(w)).length / words.length;
}

interface OverpassElement {
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function address(tags: Record<string, string>): string {
  const street = [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" ");
  return [street, tags["addr:village"], tags["addr:suburb"], tags["addr:city"]].filter(Boolean).join(", ");
}

/** Places around a point, nearest first. */
export async function nearbyOsm(q: OsmQuery, distance: (to: { lat: number; lng: number }) => number): Promise<PlaceHit[]> {
  const radius = Math.min(Math.max(q.radius ?? 3000, 100), 20_000);
  const max = Math.min(Math.max(q.max ?? 5, 1), 10);
  const byName = q.byName ?? false;
  const filter = osmFilter(q.keyword, byName);
  const query = `[out:json][timeout:20];(nwr${filter}(around:${radius},${q.lat},${q.lng}););out center ${max * 6};`;

  const res = await polite(() =>
    http(config.OVERPASS_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": AGENT },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(25_000),
    }),
  );
  if (!res.ok) throw new OsmError(`OpenStreetMap menjawab HTTP ${res.status}`);
  const json = (await res.json()) as { elements?: OverpassElement[] };

  const seen = new Set<string>();
  return (json.elements ?? [])
    .flatMap((e) => {
      const at = e.center ?? (typeof e.lat === "number" && typeof e.lon === "number" ? { lat: e.lat, lon: e.lon } : undefined);
      const name = e.tags?.name?.trim();
      if (!at || !name || seen.has(name.toLowerCase())) return [];
      seen.add(name.toLowerCase());
      const point = { lat: at.lat, lng: at.lon };
      const kind = e.tags?.cuisine ?? e.tags?.amenity ?? e.tags?.shop ?? e.tags?.tourism;
      return [
        {
          name,
          address: address(e.tags ?? {}),
          ...(kind ? { kind: kind.replace(/_/g, " ") } : {}),
          distanceKm: distance(point),
          mapsUri: `https://www.google.com/maps/search/?api=1&query=${point.lat},${point.lng}`,
        } satisfies PlaceHit,
      ];
    })
    .sort((a, b) =>
      byName || filter.startsWith('["name"')
        ? nameScore(q.keyword, b.name) - nameScore(q.keyword, a.name) || (a.distanceKm ?? 0) - (b.distanceKm ?? 0)
        : (a.distanceKm ?? 0) - (b.distanceKm ?? 0),
    )
    .slice(0, max);
}

/** Turns "Kemang, Jakarta Selatan" into a point, so an area named in chat works without a shared location. */
export async function geocodeOsm(area: string): Promise<{ lat: number; lng: number; label: string } | undefined> {
  const q = area.trim();
  if (!q) return undefined;
  const url = new URL(config.NOMINATIM_URL);
  url.search = new URLSearchParams({ q, format: "jsonv2", limit: "1", countrycodes: "id", "accept-language": "id" }).toString();
  const res = await polite(() => http(url, { headers: { "user-agent": AGENT }, signal: AbortSignal.timeout(15_000) }));
  if (!res.ok) throw new OsmError(`Pencarian alamat menjawab HTTP ${res.status}`);
  const [first] = (await res.json()) as { lat?: string; lon?: string; display_name?: string }[];
  if (!first?.lat || !first.lon) return undefined;
  return { lat: Number(first.lat), lng: Number(first.lon), label: first.display_name?.split(",").slice(0, 2).join(",").trim() ?? q };
}
