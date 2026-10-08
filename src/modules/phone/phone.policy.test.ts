import { it } from "@effect/vitest";
import { Effect, TestClock } from "effect";
import { describe, expect } from "vitest";

import { makeOtpThrottle, OtpThrottle, OtpThrottleLive } from "./phone.policy";

// 2 sends per phone and 3 per IP inside a 60-second window — small enough to
// walk every branch under the TestClock. Fresh per test: the counters are
// stateful, and each it.effect restarts the TestClock at 0.
const freshThrottle = () =>
  makeOtpThrottle({ max: 2, windowMs: 60_000 }, { max: 3, windowMs: 60_000 });

/**
 * P8.T6 — the OTP send budget (per PHONE and per IP). The global RateLimiter
 * caps raw requests at 300/min, far too loose for paid SMS sends; this policy
 * is the phone-specific fixed window, so pin: the limit, the per-key
 * independence, and the window reset — all under the TestClock.
 */
describe("OtpThrottle (phone-OTP send budgets)", () => {
  it.effect("allows up to the per-phone limit, then denies with the wait", () =>
    Effect.gen(function* () {
      const throttle = freshThrottle();
      const first = yield* throttle.consumeSend("phone", "237670123456");
      expect(first.allowed).toBe(true);
      const second = yield* throttle.consumeSend("phone", "237670123456");
      expect(second.allowed).toBe(true);
      const third = yield* throttle.consumeSend("phone", "237670123456");
      expect(third.allowed).toBe(false);
      if (!third.allowed) {
        expect(third.retryAfterSeconds).toBeGreaterThan(0);
        expect(third.retryAfterSeconds).toBeLessThanOrEqual(60);
      }
    }),
  );

  it.effect("phones have independent budgets", () =>
    Effect.gen(function* () {
      const throttle = freshThrottle();
      yield* throttle.consumeSend("phone", "237670123456");
      yield* throttle.consumeSend("phone", "237670123456");
      expect((yield* throttle.consumeSend("phone", "237699998888")).allowed).toBe(true);
    }),
  );

  it.effect("the window reset restores the budget", () =>
    Effect.gen(function* () {
      const throttle = freshThrottle();
      yield* throttle.consumeSend("phone", "237670123456");
      yield* throttle.consumeSend("phone", "237670123456");
      expect((yield* throttle.consumeSend("phone", "237670123456")).allowed).toBe(false);
      yield* TestClock.adjust("61 seconds");
      expect((yield* throttle.consumeSend("phone", "237670123456")).allowed).toBe(true);
    }),
  );

  it.effect("the IP budget is a separate, larger pool over the same window", () =>
    Effect.gen(function* () {
      const throttle = freshThrottle();
      // Three sends from the same IP, all different phones.
      expect((yield* throttle.consumeSend("ip", "10.0.0.1")).allowed).toBe(true);
      expect((yield* throttle.consumeSend("ip", "10.0.0.1")).allowed).toBe(true);
      expect((yield* throttle.consumeSend("ip", "10.0.0.1")).allowed).toBe(true);
      const fourth = yield* throttle.consumeSend("ip", "10.0.0.1");
      expect(fourth.allowed).toBe(false);
      // A different IP is unaffected.
      expect((yield* throttle.consumeSend("ip", "10.0.0.2")).allowed).toBe(true);
    }),
  );

  it.effect("phone and IP scopes never share counters", () =>
    Effect.gen(function* () {
      const throttle = freshThrottle();
      yield* throttle.consumeSend("phone", "shared-key");
      yield* throttle.consumeSend("phone", "shared-key");
      // Same literal key, different scope → its own (fresh) window.
      expect((yield* throttle.consumeSend("ip", "shared-key")).allowed).toBe(true);
    }),
  );

  it.effect("a denied decision does not extend the window", () =>
    Effect.gen(function* () {
      const throttle = freshThrottle();
      yield* throttle.consumeSend("phone", "237670123456");
      yield* throttle.consumeSend("phone", "237670123456");
      yield* throttle.consumeSend("phone", "237670123456"); // denied
      yield* throttle.consumeSend("phone", "237670123456"); // denied again
      // If denials pushed the window forward, this would still be denied.
      yield* TestClock.adjust("59 seconds");
      expect((yield* throttle.consumeSend("phone", "237670123456")).allowed).toBe(false);
      yield* TestClock.adjust("2 seconds");
      expect((yield* throttle.consumeSend("phone", "237670123456")).allowed).toBe(true);
    }),
  );

  it.effect("OtpThrottleLive builds from Config defaults and serves decisions", () =>
    Effect.gen(function* () {
      const live = yield* OtpThrottle;
      expect((yield* live.consumeSend("phone", "237600000001")).allowed).toBe(true);
      expect((yield* live.consumeSend("ip", "10.1.1.1")).allowed).toBe(true);
    }).pipe(Effect.provide(OtpThrottleLive)),
  );
});
