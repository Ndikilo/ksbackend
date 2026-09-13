import { it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, TestClock } from "effect";
import { expect } from "vitest";
import { RateLimiter, RateLimiterInMemoryLive } from "./rate-limiter";

// Strict limits injected via Config so the window behavior is easy to assert.
const strictLimiter = RateLimiterInMemoryLive.pipe(
  Layer.provide(
    Layer.setConfigProvider(
      ConfigProvider.fromMap(
        new Map([
          ["RATE_LIMIT_MAX", "2"],
          ["RATE_LIMIT_WINDOW_SECONDS", "60"],
        ]),
      ),
    ),
  ),
);

it.effect("allows up to the limit, then denies with a Retry-After hint", () =>
  Effect.gen(function* () {
    const limiter = yield* RateLimiter;
    expect((yield* limiter.consume("ip-1")).allowed).toBe(true);
    expect((yield* limiter.consume("ip-1")).allowed).toBe(true);
    const denied = yield* limiter.consume("ip-1");
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.retryAfterSeconds).toBeGreaterThan(0);
      expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
    // A different key has its own budget.
    expect((yield* limiter.consume("ip-2")).allowed).toBe(true);
  }).pipe(Effect.provide(strictLimiter)),
);

it.effect("resets the budget after the window elapses", () =>
  Effect.gen(function* () {
    const limiter = yield* RateLimiter;
    yield* limiter.consume("ip-1");
    yield* limiter.consume("ip-1");
    expect((yield* limiter.consume("ip-1")).allowed).toBe(false);
    yield* TestClock.adjust("61 seconds");
    expect((yield* limiter.consume("ip-1")).allowed).toBe(true);
  }).pipe(Effect.provide(strictLimiter)),
);
