import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import { PAYMENT_PROVIDER_IDS, PaymentProviders } from "./provider";
import { PaymentProvidersLive } from "./registry";

/**
 * The registry is what the checkout layer (P5.T3) dispatches on — a missing
 * rail would break every payment for that method. Built WITHOUT any
 * credentials to prove the layers boot from defaults (adapters fail per call,
 * not at boot).
 */
it.effect("serves every rail from env defaults with no credentials configured", () =>
  Effect.gen(function* () {
    const providers = yield* PaymentProviders;
    expect(Object.keys(providers).toSorted()).toEqual([...PAYMENT_PROVIDER_IDS].toSorted());
    expect(providers.momo?.id).toBe("momo");
    expect(providers.orange_money?.id).toBe("orange_money");
  }).pipe(Effect.provide(PaymentProvidersLive)),
);
