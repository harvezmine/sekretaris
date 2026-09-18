import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "../config.js";
import { sql, type UserRow } from "../db/index.js";
import { directionsUrl, mapsEnabled, PlacesError, searchPlaces, type TravelMode } from "../maps/places.js";
import type { ToolContext, ToolOutcome } from "./tools.js";

type BetaTool = Anthropic.Beta.BetaTool;

const ok = (value: unknown): ToolOutcome => ({ content: typeof value === "string" ? value : JSON.stringify(value) });
const fail = (message: string): ToolOutcome => ({ content: message, isError: true });

/** A shared location older than this is probably not where the user is standing any more. */
const LOCATION_MAX_AGE_HOURS = 24 * 7;

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

/** Only the lookup depends on a provider; the navigation link lives in the base tool set. */
export function mapsToolDefs(): BetaTool[] {
  return mapsEnabled() ? [DEF] : [];
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
} as const;

type MapsToolName = keyof typeof mapsInputs;

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
      const last = user.profile?.lastPlace;
      if (!last) {
        return fail(
          "Pengguna belum pernah membagikan lokasinya. Minta mereka kirim lokasi lewat menu lampiran WhatsApp (Location), atau sebutkan nama daerahnya di query.",
        );
      }
      const ageHours = (Date.now() - new Date(last.at).getTime()) / 3_600_000;
      if (ageHours > LOCATION_MAX_AGE_HOURS) {
        return fail("Lokasi terakhir yang dibagikan sudah lebih dari seminggu. Minta pengguna mengirim lokasinya lagi.");
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
    const last = user.profile?.lastPlace;
    const origin = last && Date.now() - new Date(last.at).getTime() < LOCATION_MAX_AGE_HOURS * 3_600_000
      ? { lat: last.lat, lng: last.lng }
      : undefined;

    // The link itself is free and always works; looking the place up first only makes it point at the right branch.
    let place: { name: string; address: string; id?: string } | undefined;
    if (mapsEnabled() && (await searchesToday(user)) < config.PLACE_SEARCHES_PER_DAY) {
      try {
        const [found] = await searchPlaces({ query: destination, ...(origin ?? {}), max: 1 });
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
};
