import { Clock, Config, Context, Effect, Layer } from "effect";

export type RateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

/**
 * Rate-limiter seam (docs/SCAFFOLDING_PLAN.md §6a). One tag, backend invisible
 * to consumers. This in-process fixed-window limiter enforces per-instance
 * limits so the app works with no Redis at all; a Redis layer (globally
 * coordinated) is a drop-in swap in runtime.ts when one is provisioned.
 */
export interface RateLimiterService {
  readonly consume: (key: string) => Effect.Effect<RateLimitDecision>;
}

export class RateLimiter extends Context.Tag("RateLimiter")<RateLimiter, RateLimiterService>() {}

type Window = { count: number; readonly resetAt: number };

/** Fixed-window counter per key. Uses Effect Clock — deterministic under TestClock. */
export const RateLimiterInMemoryLive = Layer.effect(
  RateLimiter,
  Effect.gen(function* () {
    const max = yield* Config.integer("RATE_LIMIT_MAX").pipe(Config.withDefault(300));
    const windowSeconds = yield* Config.integer("RATE_LIMIT_WINDOW_SECONDS").pipe(
      Config.withDefault(60),
    );
    const windowMs = windowSeconds * 1000;
    const windows = new Map<string, Window>();

    const consume = (key: string): Effect.Effect<RateLimitDecision> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        // Cheap backstop against unbounded key growth (e.g. rotating IPs).
        if (windows.size > 10_000) {
          for (const [k, w] of windows) {
            if (now >= w.resetAt) windows.delete(k);
          }
        }

        const current = windows.get(key);
        if (current === undefined || now >= current.resetAt) {
          windows.set(key, { count: 1, resetAt: now + windowMs });
          return { allowed: true } as const;
        }
        if (current.count < max) {
          current.count += 1;
          return { allowed: true } as const;
        }
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
        } as const;
      });

    return { consume };
  }),
);
