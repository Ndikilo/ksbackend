import { Clock, Config, Context, Effect, Layer, Option } from "effect";

/**
 * Cache seam (docs/SCAFFOLDING_PLAN.md §6a). Consumers depend on this ONE tag —
 * they can never tell which backend is live. String values mirror Redis
 * semantics so the Redis layer is a drop-in swap when one is provisioned:
 * implement it here in infra/ and change one line in runtime.ts. The app must
 * run perfectly without Redis — this in-process LRU is that guarantee.
 */
export interface CacheService {
  readonly get: (key: string) => Effect.Effect<Option.Option<string>>;
  readonly set: (key: string, value: string, ttlSeconds: number) => Effect.Effect<void>;
  readonly delete: (key: string) => Effect.Effect<void>;
  readonly getOrSet: (
    key: string,
    ttlSeconds: number,
    compute: Effect.Effect<string>,
  ) => Effect.Effect<string>;
}

export class Cache extends Context.Tag("Cache")<Cache, CacheService>() {}

type Entry = { readonly value: string; readonly expiresAt: number };

/** In-process bounded LRU with TTL. Per-instance — a miss is always correct. */
export const CacheInMemoryLive = Layer.effect(
  Cache,
  Effect.gen(function* () {
    const maxEntries = yield* Config.integer("CACHE_MAX_ENTRIES").pipe(Config.withDefault(1000));
    // Map iteration order doubles as recency order: re-inserting on read moves
    // the key to the back, so the front is always the least recently used.
    const store = new Map<string, Entry>();

    const get = (key: string) =>
      Effect.gen(function* () {
        const entry = store.get(key);
        if (entry === undefined) return Option.none<string>();
        const now = yield* Clock.currentTimeMillis;
        if (now >= entry.expiresAt) {
          store.delete(key);
          return Option.none<string>();
        }
        store.delete(key);
        store.set(key, entry);
        return Option.some(entry.value);
      });

    const set = (key: string, value: string, ttlSeconds: number) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        store.delete(key);
        store.set(key, { value, expiresAt: now + ttlSeconds * 1000 });
        while (store.size > maxEntries) {
          const oldest = store.keys().next().value;
          if (oldest === undefined) break;
          store.delete(oldest);
        }
      });

    const remove = (key: string) =>
      Effect.sync(() => {
        store.delete(key);
      });

    const getOrSet = (key: string, ttlSeconds: number, compute: Effect.Effect<string>) =>
      Effect.gen(function* () {
        const cached = yield* get(key);
        if (Option.isSome(cached)) return cached.value;
        const value = yield* compute;
        yield* set(key, value, ttlSeconds);
        return value;
      });

    return { get, set, delete: remove, getOrSet };
  }),
);
