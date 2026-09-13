import { Config, Context, Effect, Layer } from "effect";
import { z } from "zod";

export type Coordinates = { readonly latitude: number; readonly longitude: number };

/**
 * Turns a free-text location (city/region) into coordinates for distance search.
 * Best-effort: the error channel is `never` — an unknown place or a provider
 * hiccup resolves to `null` rather than failing the caller (coords stay unset).
 */
export interface GeocoderService {
  readonly geocode: (location: string) => Effect.Effect<Coordinates | null>;
}

export class Geocoder extends Context.Tag("Geocoder")<Geocoder, GeocoderService>() {}

// A small, deterministic gazetteer of major Cameroonian cities — enough for local
// dev/test without a network dependency. Matched accent- and case-insensitively.
const CITY_COORDS = {
  douala: { latitude: 4.05, longitude: 9.7 },
  yaounde: { latitude: 3.87, longitude: 11.52 },
  bamenda: { latitude: 5.96, longitude: 10.15 },
  bafoussam: { latitude: 5.48, longitude: 10.42 },
  buea: { latitude: 4.15, longitude: 9.24 },
  garoua: { latitude: 9.3, longitude: 13.4 },
  maroua: { latitude: 10.59, longitude: 14.32 },
  bertoua: { latitude: 4.58, longitude: 13.68 },
  ngaoundere: { latitude: 7.32, longitude: 13.58 },
  kribi: { latitude: 2.94, longitude: 9.91 },
  limbe: { latitude: 4.02, longitude: 9.2 },
  edea: { latitude: 3.8, longitude: 10.13 },
} satisfies Record<string, Coordinates>;

const normalize = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

// Deterministic pseudo-coordinate inside Cameroon's bounding box for an unknown
// place — no Math.random, so tests are stable.
const hashToCoords = (normalized: string): Coordinates => {
  let h = 0;
  for (const ch of normalized) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { latitude: 2 + (h % 1100) / 100, longitude: 8 + ((h >>> 8) % 800) / 100 };
};

const fakeLookup = (location: string): Coordinates | null => {
  const normalized = normalize(location);
  if (normalized === "") return null;
  for (const [city, coords] of Object.entries(CITY_COORDS)) {
    if (normalized.includes(city)) return coords;
  }
  return hashToCoords(normalized);
};

/** Deterministic, network-free geocoder for local dev + tests. */
export const GeocoderFakeLive = Layer.succeed(Geocoder, {
  geocode: (location) => Effect.sync(() => fakeLookup(location)),
});

// Nominatim returns an array of hits with stringly-typed coordinates; decode + coerce.
const NominatimHits = z.array(z.object({ lat: z.coerce.number(), lon: z.coerce.number() }));

/**
 * Real geocoder for deployed environments — a thin Nominatim-style HTTP lookup,
 * scoped to Cameroon. Fails soft to `null` (logged), mirroring the FileScanner
 * seam. `GEOCODER_BASE_URL` defaults to the public Nominatim host; ops can point
 * it at a self-hosted instance.
 */
export const GeocoderNominatimLive = Layer.effect(
  Geocoder,
  Effect.gen(function* () {
    const baseUrl = yield* Config.string("GEOCODER_BASE_URL").pipe(
      Config.withDefault("https://nominatim.openstreetmap.org"),
    );
    return {
      geocode: (location) =>
        normalize(location) === ""
          ? Effect.succeed(null)
          : Effect.tryPromise(async () => {
              const url = new URL(`${baseUrl}/search`);
              url.searchParams.set("q", location);
              url.searchParams.set("format", "json");
              url.searchParams.set("limit", "1");
              url.searchParams.set("countrycodes", "cm");
              const res = await fetch(url, { headers: { "user-agent": "kanasante-api" } });
              const parsed = NominatimHits.safeParse(await res.json());
              const hit = parsed.success ? parsed.data[0] : undefined;
              return hit === undefined ? null : { latitude: hit.lat, longitude: hit.lon };
            }).pipe(
              Effect.catchAll((cause) =>
                Effect.logWarning("geocode lookup failed; leaving coords unset", cause).pipe(
                  Effect.as(null),
                ),
              ),
            ),
    };
  }),
);
