import { it } from "@effect/vitest";
import { Effect, Option, TestClock } from "effect";
import { expect } from "vitest";
import { Cache, CacheInMemoryLive } from "./cache";

// Behavior tests through the Cache interface — they hold for ANY backend
// (in-memory today, Redis later). TestClock makes TTL expiry deterministic.
it.effect("stores and retrieves a value within its TTL", () =>
  Effect.gen(function* () {
    const cache = yield* Cache;
    yield* cache.set("greeting", "hello", 60);
    yield* TestClock.adjust("30 seconds");
    expect(yield* cache.get("greeting")).toEqual(Option.some("hello"));
  }).pipe(Effect.provide(CacheInMemoryLive)),
);

it.effect("expires a value after its TTL", () =>
  Effect.gen(function* () {
    const cache = yield* Cache;
    yield* cache.set("greeting", "hello", 60);
    yield* TestClock.adjust("61 seconds");
    expect(yield* cache.get("greeting")).toEqual(Option.none());
  }).pipe(Effect.provide(CacheInMemoryLive)),
);

it.effect("getOrSet computes once, then serves from cache", () =>
  Effect.gen(function* () {
    const cache = yield* Cache;
    let computations = 0;
    const compute = Effect.sync(() => {
      computations += 1;
      return "expensive";
    });
    expect(yield* cache.getOrSet("k", 60, compute)).toBe("expensive");
    expect(yield* cache.getOrSet("k", 60, compute)).toBe("expensive");
    expect(computations).toBe(1);
  }).pipe(Effect.provide(CacheInMemoryLive)),
);

it.effect("delete removes a value", () =>
  Effect.gen(function* () {
    const cache = yield* Cache;
    yield* cache.set("k", "v", 60);
    yield* cache.delete("k");
    expect(yield* cache.get("k")).toEqual(Option.none());
  }).pipe(Effect.provide(CacheInMemoryLive)),
);
