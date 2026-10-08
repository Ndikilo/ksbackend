import { Clock, Config, Context, Effect, Layer } from "effect";

import type { CooldownDecision } from "@/domain/phone/phone";

/**
 * OTP send throttle (P8.T6) — the phone-specific companion to the global
 * RateLimiter (P0): that one caps raw requests per client at 300/min, which is
 * far too loose for "send me an SMS code" (real money per message + a
 * harassment vector). This policy enforces TWO fixed windows per instance,
 * mirroring infra/rate-limiter.ts's in-process approach:
 *
 * - per PHONE  — PHONE_OTP_SEND_MAX (default 3) per PHONE_OTP_SEND_WINDOW_SECONDS
 * - per IP     — PHONE_OTP_IP_SEND_MAX (default 20) over the same window
 *
 * In-process = per-instance, like the P0 limiter; a Redis layer is the same
 * drop-in swap when globally coordinated limits matter. Verify throttling
 * (lockout after wrong codes) is NOT here — it lives on the verification row
 * (DB-backed `failed_attempts`/`locked_until`), so it survives restarts and
 * instances.
 */

export class OtpThrottle extends Context.Tag("OtpThrottle")<OtpThrottle, OtpThrottleService>() {}

export interface OtpThrottleService {
  /** Consume one send from the given scope's window. */
  readonly consumeSend: (scope: "phone" | "ip", key: string) => Effect.Effect<CooldownDecision>;
}

type WindowConfig = { readonly max: number; readonly windowMs: number };

type Window = { count: number; readonly resetAt: number };

/** Fixed-window counters per scope+key. Uses Effect Clock — TestClock-friendly. */
export const makeOtpThrottle = (phone: WindowConfig, ip: WindowConfig): OtpThrottleService => {
  const windows = new Map<string, Window>();

  const consumeSend = (scope: "phone" | "ip", key: string): Effect.Effect<CooldownDecision> =>
    Effect.gen(function* () {
      const config = scope === "phone" ? phone : ip;
      const now = yield* Clock.currentTimeMillis;
      const mapKey = `${scope}:${key}`;

      // Cheap backstop against unbounded key growth (rotating IPs/phones).
      if (windows.size > 10_000) {
        for (const [k, w] of windows) {
          if (now >= w.resetAt) windows.delete(k);
        }
      }

      const current = windows.get(mapKey);
      if (current === undefined || now >= current.resetAt) {
        windows.set(mapKey, { count: 1, resetAt: now + config.windowMs });
        return { allowed: true } as const;
      }
      if (current.count < config.max) {
        current.count += 1;
        return { allowed: true } as const;
      }
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
      } as const;
    });

  return { consumeSend };
};

export const OtpThrottleLive = Layer.effect(
  OtpThrottle,
  Effect.gen(function* () {
    const windowSeconds = yield* Config.integer("PHONE_OTP_SEND_WINDOW_SECONDS").pipe(
      Config.withDefault(15 * 60),
    );
    const windowMs = windowSeconds * 1000;
    const phoneMax = yield* Config.integer("PHONE_OTP_SEND_MAX").pipe(Config.withDefault(3));
    const ipMax = yield* Config.integer("PHONE_OTP_IP_SEND_MAX").pipe(Config.withDefault(20));
    return makeOtpThrottle({ max: phoneMax, windowMs }, { max: ipMax, windowMs });
  }),
);
