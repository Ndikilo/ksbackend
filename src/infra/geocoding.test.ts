import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { Geocoder, GeocoderFakeLive } from "./geocoding";

it.effect("resolves a known city", () =>
  Effect.gen(function* () {
    const geocoder = yield* Geocoder;
    expect(yield* geocoder.geocode("Douala")).toEqual({ latitude: 4.05, longitude: 9.7 });
  }).pipe(Effect.provide(GeocoderFakeLive)),
);

it.effect("is accent- and case-insensitive", () =>
  Effect.gen(function* () {
    const geocoder = yield* Geocoder;
    expect(yield* geocoder.geocode("Yaoundé")).toEqual({ latitude: 3.87, longitude: 11.52 });
    expect(yield* geocoder.geocode("  BAMENDA ")).toEqual({ latitude: 5.96, longitude: 10.15 });
  }).pipe(Effect.provide(GeocoderFakeLive)),
);

it.effect("returns null for an empty location", () =>
  Effect.gen(function* () {
    const geocoder = yield* Geocoder;
    expect(yield* geocoder.geocode("")).toBeNull();
    expect(yield* geocoder.geocode("   ")).toBeNull();
  }).pipe(Effect.provide(GeocoderFakeLive)),
);

it.effect("falls back to deterministic in-country coordinates for an unknown place", () =>
  Effect.gen(function* () {
    const geocoder = yield* Geocoder;
    const first = yield* geocoder.geocode("Nowhereville");
    const second = yield* geocoder.geocode("Nowhereville");
    expect(first).toEqual(second);
    expect(first).not.toBeNull();
    if (first !== null) {
      expect(first.latitude).toBeGreaterThanOrEqual(2);
      expect(first.latitude).toBeLessThan(13);
      expect(first.longitude).toBeGreaterThanOrEqual(8);
      expect(first.longitude).toBeLessThan(16);
    }
  }).pipe(Effect.provide(GeocoderFakeLive)),
);
