import { config } from "../config.js";
import { geocodeOsm, nearbyOsm, OsmError } from "./osm.js";

/**
 * Places, through Google's Places API. Unlike Calendar or Gmail this is not the user's own data: it is a server
 * API key, so there is no OAuth scope and nothing to verify — but every call costs money, which is why the tool
 * above it caps how often one user can search.
 */

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const FIELDS = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.currentOpeningHours.openNow",
  "places.googleMapsUri",
  "places.location",
  "places.primaryTypeDisplayName",
].join(",");

export interface PlaceHit {
  /** Google's place id, used to point a directions link at exactly this place. */
  id?: string;
  name: string;
  address: string;
  rating?: number;
  reviews?: number;
  price?: string;
  openNow?: boolean;
  kind?: string;
  mapsUri?: string;
  distanceKm?: number;
}

export interface PlaceQuery {
  query: string;
  lat?: number | undefined;
  lng?: number | undefined;
  /** Metres around the given point to prefer; ignored without coordinates. */
  radius?: number | undefined;
  openNow?: boolean | undefined;
  minRating?: number | undefined;
  max?: number | undefined;
  /** Looking up one specific place by name, rather than a kind of place nearby. */
  byName?: boolean | undefined;
}

export class PlacesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlacesError";
  }
}

type Fetch = typeof fetch;
let http: Fetch = (input, init) => fetch(input, init);

/** Tests swap in a fake Google. */
export function useMapsHttp(fn: Fetch | undefined): void {
  http = fn ?? ((input, init) => fetch(input, init));
}

export type Provider = "google" | "osm";

/** Which source answers a place question: Google when its key is set, OpenStreetMap otherwise. */
export function placesProvider(): Provider | undefined {
  switch (config.PLACES_PROVIDER) {
    case "off":
      return undefined;
    case "google":
      return config.GOOGLE_MAPS_API_KEY ? "google" : undefined;
    case "osm":
      return "osm";
    default:
      return config.GOOGLE_MAPS_API_KEY ? "google" : "osm";
  }
}

export function mapsEnabled(): boolean {
  return placesProvider() !== undefined;
}

/** Only Google charges per search, so only Google needs the daily cap. */
export function placesAreBilled(): boolean {
  return placesProvider() === "google";
}

const PRICE: Record<string, string> = {
  PRICE_LEVEL_FREE: "gratis",
  PRICE_LEVEL_INEXPENSIVE: "murah",
  PRICE_LEVEL_MODERATE: "sedang",
  PRICE_LEVEL_EXPENSIVE: "mahal",
  PRICE_LEVEL_VERY_EXPENSIVE: "sangat mahal",
};

/** Straight-line distance: enough to say "800 m dari Anda", not a route. */
export function distanceKm(from: { lat: number; lng: number }, to: { lat: number; lng: number }): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(to.lat - from.lat);
  const dLng = rad(to.lng - from.lng);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

interface PlaceResponse {
  places?: {
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    rating?: number;
    userRatingCount?: number;
    priceLevel?: string;
    currentOpeningHours?: { openNow?: boolean };
    googleMapsUri?: string;
    location?: { latitude?: number; longitude?: number };
    primaryTypeDisplayName?: { text?: string };
  }[];
}

export async function searchPlaces(q: PlaceQuery): Promise<PlaceHit[]> {
  const provider = placesProvider();
  if (!provider) throw new PlacesError("Pencarian tempat dimatikan di Milo ini.");
  const text = q.query.trim();
  if (!text) throw new PlacesError("Kata kunci pencarian tempat kosong.");
  const max = Math.min(Math.max(q.max ?? 5, 1), 10);
  const hasPoint = typeof q.lat === "number" && typeof q.lng === "number";
  if (provider === "osm") return searchOsm({ ...q, text, max, hasPoint });

  const res = await http(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": config.GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": FIELDS,
    },
    body: JSON.stringify({
      textQuery: text,
      maxResultCount: max,
      languageCode: "id",
      regionCode: "ID",
      ...(q.openNow ? { openNow: true } : {}),
      ...(q.minRating ? { minRating: Math.min(Math.max(q.minRating, 1), 5) } : {}),
      ...(hasPoint
        ? { locationBias: { circle: { center: { latitude: q.lat, longitude: q.lng }, radius: Math.min(Math.max(q.radius ?? 3000, 100), 50_000) } } }
        : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const message = /"message":\s*"([^"]+)"/.exec(detail)?.[1];
    throw new PlacesError(`Google Maps menjawab HTTP ${res.status}${message ? `: ${message}` : ""}`);
  }
  const json = (await res.json()) as PlaceResponse;
  const origin = hasPoint ? { lat: q.lat!, lng: q.lng! } : undefined;

  return (json.places ?? []).slice(0, max).map((p) => {
    const at = p.location;
    return {
      ...(p.id ? { id: p.id } : {}),
      name: p.displayName?.text?.trim() || "Tanpa nama",
      address: p.formattedAddress?.trim() ?? "",
      ...(typeof p.rating === "number" ? { rating: p.rating } : {}),
      ...(typeof p.userRatingCount === "number" ? { reviews: p.userRatingCount } : {}),
      ...(p.priceLevel && PRICE[p.priceLevel] ? { price: PRICE[p.priceLevel]! } : {}),
      ...(typeof p.currentOpeningHours?.openNow === "boolean" ? { openNow: p.currentOpeningHours.openNow } : {}),
      ...(p.primaryTypeDisplayName?.text ? { kind: p.primaryTypeDisplayName.text } : {}),
      ...(p.googleMapsUri ? { mapsUri: p.googleMapsUri } : {}),
      ...(origin && typeof at?.latitude === "number" && typeof at.longitude === "number"
        ? { distanceKm: distanceKm(origin, { lat: at.latitude, lng: at.longitude }) }
        : {}),
    };
  });
}

export type TravelMode = "driving" | "walking" | "bicycling" | "transit";

export interface DirectionsInput {
  destination: string;
  destinationPlaceId?: string | undefined;
  origin?: { lat: number; lng: number } | undefined;
  mode?: TravelMode | undefined;
}

/**
 * A Google Maps navigation link. This is the documented Maps URL scheme, not an API call: it costs nothing, works
 * on every phone, and opens the real Maps app with the route ready to start.
 */
export function directionsUrl(input: DirectionsInput): string {
  const params = new URLSearchParams({ api: "1", destination: input.destination.trim() });
  if (input.destinationPlaceId) params.set("destination_place_id", input.destinationPlaceId);
  if (input.origin) params.set("origin", `${input.origin.lat},${input.origin.lng}`);
  params.set("travelmode", input.mode ?? "driving");
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/**
 * OpenStreetMap needs a point to search around; when the user named an area instead ("kopi enak di Kemang"),
 * that area is geocoded first and the words that named it are dropped from the keyword.
 */
async function searchOsm(q: PlaceQuery & { text: string; max: number; hasPoint: boolean }): Promise<PlaceHit[]> {
  let lat = q.lat;
  let lng = q.lng;
  let keyword = q.text;

  if (!q.hasPoint) {
    const area = /\b(?:di|dekat|sekitar|daerah)\s+(.{3,60})$/i.exec(q.text)?.[1]?.trim();
    const found = area ? await geocodeOsm(area) : undefined;
    if (!found) {
      throw new PlacesError(
        area
          ? `Daerah "${area}" tidak ditemukan di peta. Coba sebutkan yang lebih jelas, atau minta pengguna membagikan lokasinya.`
          : "Tanpa lokasi, pencarian tempat perlu nama daerah: minta pengguna membagikan lokasinya, atau sebutkan daerahnya.",
      );
    }
    lat = found.lat;
    lng = found.lng;
    keyword = area ? q.text.slice(0, q.text.length - area.length).replace(/\b(di|dekat|sekitar|daerah)\s*$/i, "").trim() || q.text : q.text;
  }

  const origin = { lat: lat!, lng: lng! };
  try {
    return await nearbyOsm(
      { keyword, lat: origin.lat, lng: origin.lng, ...(q.radius ? { radius: q.radius } : {}), max: q.max, ...(q.byName ? { byName: true } : {}) },
      (to) => distanceKm(origin, to),
    );
  } catch (err) {
    if (err instanceof OsmError) throw new PlacesError(err.message);
    throw err;
  }
}
