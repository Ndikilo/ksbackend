import { it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { describe, expect } from "vitest";
import { RateLimiter, RateLimiterInMemoryLive } from "@/infra/rate-limiter";
import { clientKey } from "./client-key";

describe("clientKey (X-Forwarded-For → rate-limit key)", () => {
  it("keys on the LAST hop — the client-controllable leftmost entry is ignored", () => {
    expect(clientKey("203.0.113.7, 198.51.100.4")).toBe("198.51.100.4");
  });

  it("rotating the spoofable leftmost prefix keeps the key stable", () => {
    expect(clientKey("10.1.1.1, 198.51.100.4")).toBe(clientKey("203.0.113.7, 198.51.100.4"));
    expect(clientKey("10.1.1.1, 198.51.100.4")).toBe("198.51.100.4");
  });

  it("keys on the sole entry when no proxy chain is present", () => {
    expect(clientKey("198.51.100.4")).toBe("198.51.100.4");
  });

  it("trims whitespace around hops", () => {
    expect(clientKey("  198.51.100.4  ")).toBe("198.51.100.4");
    expect(clientKey("203.0.113.7,198.51.100.4")).toBe("198.51.100.4");
  });

  it("falls back to the shared local bucket when the header is absent or empty", () => {
    expect(clientKey(undefined)).toBe("local");
    expect(clientKey("")).toBe("local");
    expect(clientKey("   ")).toBe("local");
  });
});

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

it.effect("a rotating spoofed XFF prefix does not reset the fixed window", () =>
  Effect.gen(function* () {
    const limiter = yield* RateLimiter;
    // Same real client (last hop 9.9.9.9), a different spoofed prefix per request.
    expect((yield* limiter.consume(clientKey("1.1.1.1, 9.9.9.9"))).allowed).toBe(true);
    expect((yield* limiter.consume(clientKey("2.2.2.2, 9.9.9.9"))).allowed).toBe(true);
    // The spoofed rotation did not open a fresh window — the real client is limited.
    const denied = yield* limiter.consume(clientKey("3.3.3.3, 9.9.9.9"));
    expect(denied.allowed).toBe(false);
    // A genuinely different client (different last hop) keeps its own budget.
    expect((yield* limiter.consume(clientKey("3.3.3.3, 8.8.8.8"))).allowed).toBe(true);
  }).pipe(Effect.provide(strictLimiter)),
);
