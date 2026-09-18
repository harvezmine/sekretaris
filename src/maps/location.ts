import { updateProfile } from "../profile/profile.js";
import { parsePoint } from "../wa/fonnte.js";
import { geocodeOsm } from "./osm.js";
import { mapsEnabled } from "./places.js";

/**
 * Where the user is. WhatsApp's own location message is the obvious way, but not the only one people use: they
 * paste a Google Maps link from the Share button, type coordinates, or just say where they are. All of them end
 * up as the same "last place" on the profile, which is what "yang terdekat" searches around.
 */

export interface Place {
  lat: number;
  lng: number;
  label?: string;
}

type Fetch = typeof fetch;
let http: Fetch = (input, init) => fetch(input, init);

/** Tests swap in a fake Google. */
export function useLocationHttp(fn: Fetch | undefined): void {
  http = fn ?? ((input, init) => fetch(input, init));
}

/** Short links are followed only through Google's own hosts; anything else is left alone. */
const SHORT_HOSTS = new Set(["maps.app.goo.gl", "goo.gl"]);
const MAPS_HOSTS = new Set(["maps.google.com", "www.google.com", "google.com", "maps.google.co.id", "www.google.co.id", "google.co.id"]);
const LINK = /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.|maps\.)?google\.(?:com|co\.id)\/maps|maps\.google\.(?:com|co\.id))[^\s<>"')]*/i;

export async function rememberPlace(userId: string, place: Place, now = new Date()): Promise<void> {
  await updateProfile(userId, {
    lastPlace: { lat: place.lat, lng: place.lng, ...(place.label ? { label: place.label.slice(0, 120) } : {}), at: now.toISOString() },
  });
}

function decodePart(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, " ")).trim();
  } catch {
    return part;
  }
}

/**
 * Reads a full Google Maps URL: the exact place pin (!3d…!4d…) first, then the map centre (@lat,lng), then a
 * q=/query= that holds either coordinates or a place name. A directions link says where they are going, not where
 * they are, so it is ignored.
 */
export function readMapsUrl(raw: string): Place | { query: string } | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (!MAPS_HOSTS.has(url.hostname)) return undefined;
  if (/\/maps\/dir\b/.test(url.pathname)) return undefined;

  const name = /\/maps\/place\/([^/]+)/.exec(url.pathname)?.[1];
  const label = name ? decodePart(name) : undefined;
  const pin = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(url.pathname + url.search);
  const centre = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(url.pathname);
  for (const m of [pin, centre]) {
    const point = m ? parsePoint(`${m[1]},${m[2]}`) : undefined;
    if (point) return { ...point, ...(label ? { label } : {}) };
  }
  const q = url.searchParams.get("q") ?? url.searchParams.get("query") ?? url.searchParams.get("ll");
  if (q) {
    const point = parsePoint(q);
    if (point) return point;
    return { query: q.trim() };
  }
  if (label) return { query: label };
  return undefined;
}

async function expand(link: string): Promise<string | undefined> {
  let current: URL;
  try {
    current = new URL(link);
  } catch {
    return undefined;
  }
  for (let hop = 0; hop < 4; hop++) {
    if (!SHORT_HOSTS.has(current.hostname)) return MAPS_HOSTS.has(current.hostname) ? current.toString() : undefined;
    const res = await http(current, { redirect: "manual", signal: AbortSignal.timeout(6_000) });
    const next = res.headers.get("location");
    if (!next) return undefined;
    current = new URL(next, current);
  }
  return undefined;
}

/**
 * A place in a chat message: a Google Maps link (short or full), or a message that is nothing but coordinates.
 * Ordinary text is never guessed at; "saya di Kemang" is for the model to handle with location_set.
 */
export async function placeFromText(text: string): Promise<Place | undefined> {
  const bare = parsePoint(text.trim());
  if (bare) return bare;
  const link = LINK.exec(text)?.[0];
  if (!link) return undefined;
  try {
    const full = await expand(link);
    if (!full) return undefined;
    const read = readMapsUrl(full);
    if (!read) return undefined;
    if ("lat" in read) return read;
    if (!mapsEnabled()) return undefined;
    const found = await geocodeOsm(read.query);
    return found ? { lat: found.lat, lng: found.lng, label: read.query } : undefined;
  } catch {
    return undefined;
  }
}

/** Quick check before any network call: is there anything in this text that could be a place at all? */
export function mightBePlace(text: string): boolean {
  return LINK.test(text) || parsePoint(text.trim()) !== undefined;
}
