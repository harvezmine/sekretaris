import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { runTool, toolsFor } from "../src/agent/tools.ts";
import { mapsToolDefs } from "../src/agent/mapsTools.ts";
import { config } from "../src/config.ts";
import { migrate, sql, type UserRow } from "../src/db/index.ts";
import { directionsUrl, distanceKm, placesProvider, searchPlaces, useMapsHttp } from "../src/maps/places.ts";
import { nameScore, osmFilter, useOsmHttp } from "../src/maps/osm.ts";

const KEMANG = { lat: -6.2607, lng: 106.8134 };
const dbEnabled = Boolean(process.env.TEST_DATABASE_URL);

/** The tools write to the usage ledger, so they need a real row to point at. */
let stored: UserRow;
const user = (patch: Partial<UserRow> = {}) => ({ ...stored, ...patch }) as UserRow;

interface Call {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function fakeMaps(reply: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  useMapsHttp((async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = {
      url: String(input),
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>,
    };
    calls.push(call);
    return reply(call);
  }) as typeof fetch);
  return calls;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const WARUNG = {
  id: "ChIJwarung",
  displayName: { text: "Warung Sunda Asri" },
  formattedAddress: "Jl. Kemang Raya 12, Jakarta Selatan",
  rating: 4.6,
  userRatingCount: 1820,
  priceLevel: "PRICE_LEVEL_INEXPENSIVE",
  currentOpeningHours: { openNow: true },
  googleMapsUri: "https://maps.google.com/?cid=1",
  location: { latitude: -6.2635, longitude: 106.8146 },
  primaryTypeDisplayName: { text: "Restoran Sunda" },
};

function fakeOsm(reply: (url: string, body: string) => Response): { url: string; body: string }[] {
  const calls: { url: string; body: string }[] = [];
  useOsmHttp((async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const body = init.body instanceof URLSearchParams ? init.body.toString() : String(init.body ?? "");
    calls.push({ url, body });
    return reply(url, body);
  }) as typeof fetch);
  return calls;
}

afterEach(() => {
  useMapsHttp(undefined);
  useOsmHttp(undefined);
  Object.assign(config, { GOOGLE_MAPS_API_KEY: "", PLACES_PROVIDER: "auto" });
});

describe("places", { skip: !dbEnabled && "set TEST_DATABASE_URL to run" }, () => {
  before(async () => {
    await migrate();
    await sql`delete from users where wa_id = '6281400000001'`;
    const [row] = await sql<UserRow[]>`
      insert into users (wa_id, display_name, status, plan, state) values ('6281400000001', 'Uji', 'trialing', 'trial', 'READY') returning *
    `;
    stored = row!;
    config.PLACES_PROVIDER = "auto";
  });

  after(async () => {
    await sql`delete from users where id = ${stored.id}`;
    await sql.end({ timeout: 5 });
  });

  test("a search is sent with the key, the fields and the user's point, and comes back trimmed", async () => {
    config.GOOGLE_MAPS_API_KEY = "maps-key";
    const calls = fakeMaps(() => json({ places: [WARUNG, { displayName: { text: "Tanpa alamat" } }] }));

    const hits = await searchPlaces({ query: "restoran sunda", lat: KEMANG.lat, lng: KEMANG.lng, openNow: true, minRating: 4, max: 2 });
    assert.deepEqual(hits[0], {
      id: "ChIJwarung",
      name: "Warung Sunda Asri",
      address: "Jl. Kemang Raya 12, Jakarta Selatan",
      rating: 4.6,
      reviews: 1820,
      price: "murah",
      openNow: true,
      kind: "Restoran Sunda",
      mapsUri: "https://maps.google.com/?cid=1",
      distanceKm: 0.3,
    });
    assert.deepEqual(hits[1], { name: "Tanpa alamat", address: "" }, "a place with nothing but a name still parses");

    const call = calls[0]!;
    assert.equal(call.headers.get("X-Goog-Api-Key"), "maps-key");
    assert.match(String(call.headers.get("X-Goog-FieldMask")), /places\.rating/);
    assert.equal(call.body.textQuery, "restoran sunda");
    assert.equal(call.body.openNow, true);
    assert.equal(call.body.minRating, 4);
    assert.equal(call.body.regionCode, "ID");
    assert.deepEqual(call.body.locationBias, { circle: { center: { latitude: KEMANG.lat, longitude: KEMANG.lng }, radius: 3000 } });
  });

  test("place search can be switched off, but the free navigation link stays", async () => {
    config.PLACES_PROVIDER = "off";
    assert.deepEqual(mapsToolDefs(), [], "only the lookup is behind a provider");
    const names = toolsFor(user()).map((t) => t.name);
    assert.ok(!names.includes("place_search"));
    assert.ok(names.includes("place_directions"), "a Maps link costs nothing, so it is always there");
    assert.equal((await runTool({ user: user() }, "place_search", { query: "restoran" })).isError, true);
    assert.match(String((await runTool({ user: user() }, "place_directions", { destination: "Monas" })).content), /maps\/dir/);

    config.PLACES_PROVIDER = "auto";
    config.GOOGLE_MAPS_API_KEY = "maps-key";
    assert.deepEqual(mapsToolDefs().map((t) => t.name), ["place_search"]);
    fakeMaps(() => json({ error: { message: "This API key is not authorized" } }, 403));
    const out = await runTool({ user: user() }, "place_search", { query: "restoran" });
    assert.equal(out.isError, true);
    assert.match(String(out.content), /HTTP 403: This API key is not authorized/);
  });

  test('"near me" needs a location the user shared, and remembers it afterwards', async () => {
    config.GOOGLE_MAPS_API_KEY = "maps-key";
    const never = await runTool({ user: user() }, "place_search", { query: "bensin terdekat", near: "saya" });
    assert.equal(never.isError, true);
    assert.match(String(never.content), /belum pernah membagikan lokasinya/);

    const stale = user({ profile: { lastPlace: { ...KEMANG, at: new Date(Date.now() - 8 * 86_400_000).toISOString() } } });
    assert.match(String((await runTool({ user: stale }, "place_search", { query: "bensin", near: "saya" })).content), /lebih dari seminggu/);

    const calls = fakeMaps(() => json({ places: [WARUNG] }));
    const known = user({ profile: { lastPlace: { ...KEMANG, label: "Kemang", at: new Date(Date.now() - 2 * 3_600_000).toISOString() } } });
    const found = JSON.parse(String((await runTool({ user: known }, "place_search", { query: "bensin", near: "saya", radius_km: 1 })).content)) as {
      around: string;
      shared_hours_ago: number;
      places: { distanceKm: number }[];
    };
    assert.equal(found.around, "Kemang");
    assert.equal(found.shared_hours_ago, 2);
    assert.equal(found.places[0]!.distanceKm, 0.3);
    assert.deepEqual((calls[0]!.body.locationBias as { circle: { radius: number } }).circle.radius, 1000);
  });

  test("without a Google key, places come from OpenStreetMap for free", () => {
    assert.equal(placesProvider(), "osm", "the free source is the default");
    config.GOOGLE_MAPS_API_KEY = "maps-key";
    assert.equal(placesProvider(), "google", "a key upgrades it");
    config.PLACES_PROVIDER = "off";
    assert.equal(placesProvider(), undefined);

    assert.equal(osmFilter("SPBU terdekat"), '["amenity"="fuel"]');
    assert.equal(osmFilter("pom bensin"), '["amenity"="fuel"]');
    assert.equal(osmFilter("cari ATM"), '["amenity"="atm"]');
    assert.equal(osmFilter("warung padang enak"), '["amenity"="restaurant"]');
    assert.equal(osmFilter("ngopi dong"), '["amenity"="cafe"]');
    assert.equal(osmFilter("apotek 24 jam"), '["amenity"="pharmacy"]');
    assert.equal(osmFilter("Mall Kelapa Gading"), '["shop"="mall"]');
    assert.equal(osmFilter("Warung Sunda Asri", true), '["name"~"Warung|Sunda|Asri",i]', "a name wins over the category word inside it");
    assert.equal(osmFilter("toko bunga"), '["name"~"toko|bunga",i]', "anything unmapped falls back to the name");
    assert.equal(osmFilter('nama "aneh"'), '["name"~"nama|\\"aneh\\"",i]', "a quote cannot end the filter early");
  });

  test("OpenStreetMap results are nearest-first, named, and honest about having no ratings", async () => {
    const calls = fakeOsm(() =>
      json({
        elements: [
          { lat: -6.28, lon: 106.82, tags: { name: "SPBU Jauh", amenity: "fuel" } },
          { center: { lat: -6.2635, lon: 106.8146 }, tags: { name: "SPBU Kemang", amenity: "fuel", "addr:street": "Jl. Kemang Raya", "addr:city": "Jakarta" } },
          { lat: -6.262, lon: 106.814, tags: { amenity: "fuel" } },
          { lat: -6.2636, lon: 106.8147, tags: { name: "spbu kemang", amenity: "fuel" } },
        ],
      }),
    );
    const known = user({ profile: { lastPlace: { ...KEMANG, label: "Kemang", at: new Date().toISOString() } } });
    const out = JSON.parse(String((await runTool({ user: known }, "place_search", { query: "SPBU terdekat", near: "saya" })).content)) as {
      places: { name: string; address: string; distanceKm: number; rating?: number; mapsUri: string }[];
    };
    assert.deepEqual(
      out.places.map((p) => p.name),
      ["SPBU Kemang", "SPBU Jauh"],
      "nearest first, unnamed dropped, duplicate name dropped",
    );
    assert.equal(out.places[0]!.address, "Jl. Kemang Raya, Jakarta");
    assert.equal(out.places[0]!.rating, undefined, "OSM has no ratings and none are invented");
    assert.match(out.places[0]!.mapsUri, /maps\/search\/\?api=1&query=-6\.2635,106\.8146/);
    assert.match(calls[0]!.body, /around%3A3000%2C-6\.2607%2C106\.8134/);
    assert.match(calls[0]!.body, /amenity.*fuel/);
  });

  test("a name from a review article resolves to the right place, not the nearest one", async () => {
    assert.equal(nameScore("Warung Sunda Asri", "Warung Sunda Asri"), 1);
    assert.equal(nameScore("Warung Sunda Asri", "Warung Padang Sederhana"), 1 / 3);
    assert.equal(nameScore("Warung Sunda Asri", "Bakso Pak Kumis"), 0);

    fakeOsm(() =>
      json({
        elements: [
          { lat: -6.2608, lon: 106.8135, tags: { name: "Warung Tegal Bahari" } },
          { lat: -6.28, lon: 106.82, tags: { name: "Warung Sunda Asri" } },
        ],
      }),
    );
    const known = user({ profile: { lastPlace: { ...KEMANG, at: new Date().toISOString() } } });
    const out = JSON.parse(
      String((await runTool({ user: known }, "place_search", { query: "Warung Sunda Asri", near: "saya", name_lookup: true })).content),
    ) as { places: { name: string; distanceKm: number }[] };
    assert.equal(out.places[0]!.name, "Warung Sunda Asri", "the name that was asked for wins over the closer one");
    assert.ok(out.places[0]!.distanceKm > out.places[1]!.distanceKm, "even though it is further away");
  });

  test("an area named in chat is geocoded, and a place nobody knows says so", async () => {
    fakeOsm((url) =>
      url.includes("nominatim")
        ? json([{ lat: "-6.2607", lon: "106.8134", display_name: "Kemang, Jakarta Selatan, Indonesia" }])
        : json({ elements: [{ lat: -6.2635, lon: 106.8146, tags: { name: "Kopi Kemang", amenity: "cafe" } }] }),
    );
    const out = JSON.parse(String((await runTool({ user: user() }, "place_search", { query: "kopi enak di Kemang" })).content)) as {
      places: { name: string }[];
    };
    assert.deepEqual(out.places.map((p) => p.name), ["Kopi Kemang"]);

    fakeOsm(() => json([]));
    const nowhere = await runTool({ user: user() }, "place_search", { query: "kopi di Xyzzyland" });
    assert.equal(nowhere.isError, true);
    assert.match(String(nowhere.content), /tidak ditemukan di peta/);
  });

  test("directions resolve the real place and hand back a Maps link", async () => {
    config.GOOGLE_MAPS_API_KEY = "maps-key";
    fakeMaps(() =>
      json({
        places: [
          {
            id: "ChIJmkg",
            displayName: { text: "Mall Kelapa Gading" },
            formattedAddress: "Jl. Boulevard Bar. Raya, Jakarta Utara",
            location: { latitude: -6.1577, longitude: 106.9065 },
          },
        ],
      }),
    );
    const known = user({ profile: { lastPlace: { ...KEMANG, at: new Date().toISOString() } } });
    const out = JSON.parse(String((await runTool({ user: known }, "place_directions", { destination: "mall kelapa gading" })).content)) as {
      destination: { name: string };
      url: string;
      mode: string;
    };
    assert.equal(out.destination.name, "Mall Kelapa Gading");
    assert.equal(out.mode, "driving");
    const url = new URL(out.url);
    assert.equal(url.origin + url.pathname, "https://www.google.com/maps/dir/");
    assert.equal(url.searchParams.get("destination"), "Mall Kelapa Gading, Jl. Boulevard Bar. Raya, Jakarta Utara");
    assert.equal(url.searchParams.get("destination_place_id"), "ChIJmkg");
    assert.equal(url.searchParams.get("origin"), `${KEMANG.lat},${KEMANG.lng}`);
    assert.equal(url.searchParams.get("travelmode"), "driving");
  });

  test("a link is still produced when Google cannot be reached, and distance is real", async () => {
    config.GOOGLE_MAPS_API_KEY = "maps-key";
    fakeMaps(() => json({ error: { message: "down" } }, 500));
    const out = JSON.parse(String((await runTool({ user: user() }, "place_directions", { destination: "Monas", mode: "walking" })).content)) as {
      destination: { address: string };
      from: string;
      url: string;
    };
    assert.equal(out.destination.address, "belum dipastikan");
    assert.equal(out.from, "posisi pengguna saat membuka link");
    assert.match(out.url, /destination=Monas&travelmode=walking$/);

    assert.equal(distanceKm(KEMANG, KEMANG), 0);
    assert.equal(distanceKm({ lat: -6.2, lng: 106.8 }, { lat: -6.3, lng: 106.8 }), 11.1);
    assert.equal(
      directionsUrl({ destination: "Bandara Soekarno-Hatta", mode: "transit" }),
      "https://www.google.com/maps/dir/?api=1&destination=Bandara+Soekarno-Hatta&travelmode=transit",
    );
  });
});
