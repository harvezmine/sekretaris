import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "../config.js";
import { getUser, sql, type UserRow } from "../db/index.js";
import { rememberPlace } from "../maps/location.js";
import { geocodeOsm, OsmError } from "../maps/osm.js";
import { directionsUrl, mapsEnabled, PlacesError, searchPlaces, type TravelMode } from "../maps/places.js";
import { LOCATION_LINK_MINUTES, locationUrlFor } from "../uploads/links.js";
import type { ToolContext, ToolOutcome } from "./tools.js";

type BetaTool = Anthropic.Beta.BetaTool;

const ok = (value: unknown): ToolOutcome => ({ content: typeof value === "string" ? value : JSON.stringify(value) });
const fail = (message: string): ToolOutcome => ({ content: message, isError: true });

/** A shared location older than this is probably not where the user is standing any more. */
const LOCATION_MAX_AGE_HOURS = 24 * 7;
/** A route starts from the stored place only if it was just shared; otherwise Maps uses where the phone is now. */
const ORIGIN_MAX_AGE_MINUTES = 60;

const DEF: BetaTool = {
  name: "place_search",
  description: [
    "Find real places: restaurants, cafés, petrol stations, ATMs, pharmacies, workshops, hotels — anything with an address. Returns name, address, distance and a Maps link, plus rating, number of reviews, price level and whether it is open now when the source has them.",
    'Set near to "saya" to search around the location the user shared in this chat; otherwise put the area in the query itself ("kopi enak di Kemang"). If near is "saya" and the user has never shared a location, the result says so: ask them to send their location through WhatsApp\'s attachment menu.',
    "Say what you found in a few lines — name, why it fits, distance or rating — and give the Maps link only for the one or two you actually recommend. Never invent a place, an address or a rating. When the results carry no ratings and the user asked for somewhere good, say the list is by distance and offer to look up what people say about them.",
  ].join("\n\n"),
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for, in the user's language, e.g. \"restoran padang enak\"." },
      near: { type: "string", description: 'Only "saya" for around the user; leave out otherwise.' },
      open_now: { type: "boolean", description: "Only places open right now." },
      min_rating: { type: "number", description: "Lowest Google rating to accept, 1-5." },
      max: { type: "integer", description: "How many results, 1-10. Default 5." },
      radius_km: { type: "number", description: 'Only with near="saya": how far to look, default 3 km.' },
      name_lookup: {
        type: "boolean",
        description:
          "true when query is one specific place's name that you want to confirm — a name you read in an article, for example. The answer is then the best name match rather than the nearest place of that kind.",
      },
    },
    required: ["query"],
  },
};

/** Always available: a Maps link is a plain URL, so it needs no provider, no key and costs nothing. */
export const DIRECTIONS_TOOL_DEF: BetaTool = {
  name: "place_directions",
  description: [
    "Give the user a Google Maps navigation link to somewhere: \"saya mau ke Mall Kelapa Gading, arahkan saya\". The place is looked up first, so the link points at the real one, with its address.",
    "The route starts from the location the user shared in this chat when there is one, otherwise from wherever they are when they open it. Send the link as plain text on its own line, with one short line saying which place it is. mode: driving (default), walking, transit; a motorbike counts as driving.",
  ].join("\n\n"),
  input_schema: {
    type: "object",
    properties: {
      destination: { type: "string", description: "Where they want to go, as they said it." },
      mode: { type: "string", enum: ["driving", "walking", "transit"] },
    },
    required: ["destination"],
  },
};

const LOCATION_SET: BetaTool = {
  name: "location_set",
  description:
    "Remember where the user is when they say it in words: \"saya lagi di Grand Indonesia\", \"posisi saya di Bandung\". The place is looked up on the map and stored as their current location, so near=\"saya\" and directions start from it. Say which place was matched in a few words; if it looks wrong, ask them to be more specific or share their location.",
  input_schema: {
    type: "object",
    properties: { place: { type: "string", description: "The place as they named it, with the city if they gave one." } },
    required: ["place"],
  },
};

/** Always available: a page link that needs no map provider, only the phone's own GPS. */
export const LOCATION_LINK_TOOL_DEF: BetaTool = {
  name: "location_link",
  description:
    "Get a private link that asks the user's phone for its current position. Offer it when you need their location and they have not shared one, or when a location they sent did not come through. Send the link as plain text; it is valid for 30 minutes. The user can also type LOKASI to get it.",
  input_schema: { type: "object", properties: {} },
};

/** Only the lookup depends on a provider; the navigation link lives in the base tool set. */
export function mapsToolDefs(): BetaTool[] {
  return mapsEnabled() ? [DEF, LOCATION_SET] : [];
}

export const mapsInputs = {
  place_search: z.object({
    query: z.string().min(1).max(200),
    near: z.string().max(20).optional(),
    open_now: z.boolean().optional(),
    min_rating: z.coerce.number().optional(),
    max: z.coerce.number().int().optional(),
    radius_km: z.coerce.number().optional(),
    name_lookup: z.boolean().optional(),
  }),
  place_directions: z.object({
    destination: z.string().min(1).max(200),
    mode: z.enum(["driving", "walking", "transit"]).optional(),
  }),
  location_set: z.object({ place: z.string().min(2).max(200) }),
  location_link: z.object({}).loose(),
} as const;

type MapsToolName = keyof typeof mapsInputs;

/** Read fresh: a location_set or shared location earlier in the same turn must already count. */
async function lastPlaceOf(user: UserRow): Promise<NonNullable<UserRow["profile"]["lastPlace"]> | undefined> {
  return (await getUser(user.id))?.profile?.lastPlace ?? user.profile?.lastPlace;
}

async function searchesToday(user: UserRow): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*) as n from usage_ledger where user_id = ${user.id} and kind = 'places' and created_at > now() - interval '1 day'
  `;
  return Number(row?.n ?? 0);
}

export const mapsHandlers: {
  [K in MapsToolName]: (ctx: ToolContext, input: z.infer<(typeof mapsInputs)[K]>) => Promise<ToolOutcome>;
} = {
  async place_search({ user }, { query, near, open_now, min_rating, max, radius_km, name_lookup }) {
    if (!mapsEnabled()) return fail("Pencarian tempat dimatikan di Milo ini.");
    if ((await searchesToday(user)) >= config.PLACE_SEARCHES_PER_DAY) {
      return fail(`Batas ${config.PLACE_SEARCHES_PER_DAY} pencarian tempat per hari sudah tercapai.`);
    }

    let point: { lat: number; lng: number; label?: string; ageHours?: number } | undefined;
    if (near && /^(saya|aku|me|sini|dekat)/i.test(near.trim())) {
      const last = await lastPlaceOf(user);
      if (!last) {
        return fail(
          "Pengguna belum pernah membagikan lokasinya. Tawarkan tiga cara singkat: kirim lokasi lewat WhatsApp, tempel link Google Maps, atau buka link dari location_link. Kalau mereka menyebut tempatnya dengan kata-kata, simpan dengan location_set.",
        );
      }
      const ageHours = (Date.now() - new Date(last.at).getTime()) / 3_600_000;
      if (ageHours > LOCATION_MAX_AGE_HOURS) {
        return fail("Lokasi terakhir yang dibagikan sudah lebih dari seminggu. Minta lokasi yang baru: tawarkan location_link, atau mereka bisa menyebut tempatnya.");
      }
      point = { lat: last.lat, lng: last.lng, ...(last.label ? { label: last.label } : {}), ageHours: Math.round(ageHours) };
    }

    try {
      const places = await searchPlaces({
        query,
        ...(point ? { lat: point.lat, lng: point.lng } : {}),
        ...(radius_km ? { radius: Math.round(radius_km * 1000) } : {}),
        ...(open_now === undefined ? {} : { openNow: open_now }),
        ...(min_rating === undefined ? {} : { minRating: min_rating }),
        ...(max === undefined ? {} : { max }),
        ...(name_lookup ? { byName: true } : {}),
      });
      await sql`insert into usage_ledger (user_id, kind, units) values (${user.id}, 'places', 1)`;
      if (!places.length) return ok(`Tidak ada tempat yang cocok dengan "${query}".`);
      return ok({
        ...(point ? { around: point.label ?? "lokasi yang dibagikan pengguna", shared_hours_ago: point.ageHours } : {}),
        places,
      });
    } catch (err) {
      if (err instanceof PlacesError) return fail(`Pencarian tempat gagal: ${err.message}`);
      throw err;
    }
  },

  async place_directions({ user }, { destination, mode }) {
    const last = await lastPlaceOf(user);
    const age = last ? Date.now() - new Date(last.at).getTime() : Infinity;
    // Picking the nearest branch can use a place from earlier in the week; the route itself should not.
    const near = age < LOCATION_MAX_AGE_HOURS * 3_600_000 ? { lat: last!.lat, lng: last!.lng } : undefined;
    const origin = age < ORIGIN_MAX_AGE_MINUTES * 60_000 ? near : undefined;

    // The link itself is free and always works; looking the place up first only makes it point at the right branch.
    let place: { name: string; address: string; id?: string } | undefined;
    if (mapsEnabled() && (await searchesToday(user)) < config.PLACE_SEARCHES_PER_DAY) {
      try {
        const [found] = await searchPlaces({ query: destination, ...(near ?? {}), max: 1 });
        if (found) place = found;
        await sql`insert into usage_ledger (user_id, kind, units) values (${user.id}, 'places', 1)`;
      } catch (err) {
        if (!(err instanceof PlacesError)) throw err;
      }
    }

    const url = directionsUrl({
      destination: place ? `${place.name}, ${place.address}` : destination,
      ...(place?.id ? { destinationPlaceId: place.id } : {}),
      ...(origin ? { origin } : {}),
      ...(mode ? { mode: mode as TravelMode } : {}),
    });
    return ok({
      destination: place ? { name: place.name, address: place.address } : { name: destination, address: "belum dipastikan" },
      from: origin ? (last!.label ?? "lokasi yang dibagikan pengguna") : "posisi pengguna saat membuka link",
      mode: mode ?? "driving",
      url,
    });
  },

  async location_set({ user }, { place }) {
    if (!mapsEnabled()) return fail("Pencarian tempat dimatikan di Milo ini.");
    try {
      const found = await geocodeOsm(place);
      if (!found) return fail(`"${place}" tidak ketemu di peta. Minta nama tempat yang lebih jelas, atau minta mereka membagikan lokasi.`);
      await rememberPlace(user.id, { lat: found.lat, lng: found.lng, label: found.label });
      return ok({ saved: found.label, lat: found.lat, lng: found.lng });
    } catch (err) {
      if (err instanceof OsmError) return fail(`Peta sedang tidak bisa dibuka: ${err.message}`);
      throw err;
    }
  },

  async location_link({ user }) {
    const url = locationUrlFor(user.id);
    if (!url) return fail("Link lokasi belum tersedia karena alamat publik Milo belum diketahui. Minta pengguna mengirim lokasi lewat WhatsApp.");
    return ok({ url, valid_minutes: LOCATION_LINK_MINUTES });
  },
};
