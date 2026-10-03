import { Effect, Layer } from "effect";

import { MomoProvider, MomoProviderLive } from "./momo";
import { OrangeMoneyProvider, OrangeMoneyProviderLive } from "./orange-money";
import { PaymentProviders } from "./provider";

/**
 * Registry assembly (P5.T1): both env-configured adapters served under the
 * `PaymentProviders` tag the checkout layer (P5.T3) dispatches by method on.
 * Constructing the layers is safe without credentials — adapters read their
 * env with sandbox defaults/empty fallbacks and fail PER CALL with
 * `not_configured`, so boot never depends on merchant credentials.
 */
const PaymentProvidersFromAdapters = Layer.effect(
  PaymentProviders,
  Effect.gen(function* () {
    const momo = yield* MomoProvider;
    const orange = yield* OrangeMoneyProvider;
    return { momo, orange_money: orange };
  }),
);

export const PaymentProvidersLive = PaymentProvidersFromAdapters.pipe(
  Layer.provide(MomoProviderLive),
  Layer.provide(OrangeMoneyProviderLive),
);
