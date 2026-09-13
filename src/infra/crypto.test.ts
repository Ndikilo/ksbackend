import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { Crypto, CryptoLive } from "./crypto";

// Keys come from process.env set in vitest.config.ts.
it.effect("encrypt then decrypt round-trips, and ciphertext hides the value", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto;
    const cipher = yield* crypto.encrypt("AA123456");
    expect(cipher).not.toContain("AA123456");
    expect(yield* crypto.decrypt(cipher)).toBe("AA123456");
  }).pipe(Effect.provide(CryptoLive)),
);

it.effect("hmac is deterministic, distinguishes inputs, and hides the value", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto;
    const a = crypto.hmac("AA123456");
    const b = crypto.hmac("AA123456");
    const c = crypto.hmac("BB999999");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain("AA123456");
  }).pipe(Effect.provide(CryptoLive)),
);

it.effect("decrypt fails (typed) on tampered ciphertext", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto;
    const result = yield* Effect.either(crypto.decrypt("not.valid.data"));
    expect(result._tag).toBe("Left");
  }).pipe(Effect.provide(CryptoLive)),
);
