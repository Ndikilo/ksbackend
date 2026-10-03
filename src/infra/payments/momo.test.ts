import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { z } from "zod";

import { makeMomoProvider } from "./momo";
import {
  type FetchJson,
  type ProviderHttpDeps,
  PaymentProviderError,
  validateChargeInput,
} from "./provider";

/** The requesttopay body, decoded instead of cast (repo rule: decode, don't cast). */
const RequestToPayBody = z.object({
  amount: z.string(),
  currency: z.literal("XAF"),
  externalId: z.string(),
  payer: z.object({ partyIdType: z.literal("MSISDN"), partyId: z.string() }),
  payerMessage: z.string(),
  payeeNote: z.string(),
});

/**
 * Contract tests against RECORDED fixture shapes of the MoMo Collections
 * sandbox contract (token → requesttopay 202 → status). The scripted fetch
 * asserts the REQUEST (url, method, auth headers, idempotency, body) and the
 * adapters' decoding of the RESPONSE — no network, no credentials.
 */

type Call = { readonly url: string; readonly init: Parameters<FetchJson>[1] };

const TOKEN_FIXTURE = { access_token: "tok-1", token_type: "access_token", expires_in: 3600 };

const makeDeps = (
  handler: (call: Call) => { readonly status: number; readonly body: unknown },
  recorded: Call[],
): ProviderHttpDeps & {
  readonly subscriptionKey: string;
  readonly apiUser: string;
  readonly apiKey: string;
  readonly targetEnv: string;
} => ({
  baseUrl: "https://sandbox.momodeveloper.mtn.com",
  subscriptionKey: "sub-key",
  apiUser: "api-user",
  apiKey: "api-key",
  targetEnv: "sandbox",
  fetchJson: (url, init) => {
    recorded.push({ url, init });
    return Promise.resolve(handler({ url, init }));
  },
});

const INPUT = {
  referenceId: "0f0e0d0c-1111-2222-3333-444455556666",
  amountXaf: 5000,
  payerPhone: "6 51-23 45 67",
  description: "Consultation — Dr Ada Nkotto",
} as const;

it.effect("initiate follows the contract: token → requesttopay, idempotent by referenceId", () =>
  Effect.gen(function* () {
    const recorded: Call[] = [];
    const provider = makeMomoProvider(
      makeDeps(
        ({ url }) =>
          url.endsWith("/collection/token/")
            ? { status: 200, body: TOKEN_FIXTURE }
            : { status: 202, body: null },
        recorded,
      ),
    );

    const charge = yield* provider.initiate(INPUT);
    expect(charge).toEqual({
      providerChargeId: INPUT.referenceId,
      status: "pending",
    });

    const [tokenCall, chargeCall, third] = recorded;
    expect(tokenCall?.url).toBe("https://sandbox.momodeveloper.mtn.com/collection/token/");
    expect(tokenCall?.init.method).toBe("POST");
    expect(tokenCall?.init.headers.Authorization).toBe(`Basic ${btoa("api-user:api-key")}`);
    expect(tokenCall?.init.headers["Ocp-Apim-Subscription-Key"]).toBe("sub-key");

    expect(third).toBeUndefined();
    expect(chargeCall?.init.headers.Authorization).toBe("Bearer tok-1");
    expect(chargeCall?.init.headers["X-Reference-Id"]).toBe(INPUT.referenceId);
    expect(chargeCall?.init.headers["X-Target-Environment"]).toBe("sandbox");
    const body = RequestToPayBody.parse(JSON.parse(chargeCall?.init.body ?? ""));
    expect(body.amount).toBe("5000"); // MoMo takes the integer amount as a string
    expect(body.externalId).toBe(INPUT.referenceId);
    expect(body.payer).toEqual({ partyIdType: "MSISDN", partyId: "237651234567" });
    expect(body.payerMessage).toBe(INPUT.description);
  }),
);

it.effect("status maps the contract statuses onto the charge lifecycle", () =>
  Effect.gen(function* () {
    const recorded: Call[] = [];
    const provider = makeMomoProvider(
      makeDeps(
        ({ url }) =>
          url.endsWith("/collection/token/")
            ? { status: 200, body: TOKEN_FIXTURE }
            : { status: 200, body: { status: "SUCCESSFUL", amount: "5000" } },
        recorded,
      ),
    );
    expect(yield* provider.status(INPUT.referenceId)).toBe("succeeded");
    expect(recorded[1]?.url).toBe(
      `https://sandbox.momodeveloper.mtn.com/collection/v1_0/requesttopay/${INPUT.referenceId}`,
    );
    expect(recorded[1]?.init.method).toBe("GET");
  }),
);

it.effect("PENDING and FAILED map to pending and failed", () =>
  Effect.gen(function* () {
    const make = (status: string) => {
      const recorded: Call[] = [];
      return makeMomoProvider(
        makeDeps(
          ({ url }) =>
            url.endsWith("/collection/token/")
              ? { status: 200, body: TOKEN_FIXTURE }
              : { status: 200, body: { status } },
          recorded,
        ),
      );
    };
    expect(yield* make("PENDING").status(INPUT.referenceId)).toBe("pending");
    expect(yield* make("FAILED").status(INPUT.referenceId)).toBe("failed");
  }),
);

it.effect("a 409 on initiate is an idempotent retry hit, not a failure", () =>
  Effect.gen(function* () {
    const recorded: Call[] = [];
    const provider = makeMomoProvider(
      makeDeps(
        ({ url }) =>
          url.endsWith("/collection/token/")
            ? { status: 200, body: TOKEN_FIXTURE }
            : { status: 409, body: null },
        recorded,
      ),
    );
    const charge = yield* provider.initiate(INPUT);
    expect(charge.status).toBe("pending");
  }),
);

it.effect("4xx declines and 5xx provider errors surface as typed kinds", () =>
  Effect.gen(function* () {
    const make = (status: number) => {
      const recorded: Call[] = [];
      return makeMomoProvider(
        makeDeps(
          ({ url }) =>
            url.endsWith("/collection/token/")
              ? { status: 200, body: TOKEN_FIXTURE }
              : { status, body: null },
          recorded,
        ),
      );
    };
    const declined = yield* make(400).initiate(INPUT).pipe(Effect.flip);
    expect(declined.kind).toBe("declined");

    const providerError = yield* make(500).initiate(INPUT).pipe(Effect.flip);
    expect(providerError.kind).toBe("provider");
  }),
);

it.effect("a token response outside the contract fails as unexpected_response", () =>
  Effect.gen(function* () {
    const recorded: Call[] = [];
    const provider = makeMomoProvider(
      makeDeps(
        ({ url }) =>
          url.endsWith("/collection/token/")
            ? { status: 200, body: { unexpected: true } }
            : { status: 202, body: null },
        recorded,
      ),
    );
    const error = yield* provider.initiate(INPUT).pipe(Effect.flip);
    expect(error._tag).toBe("PaymentProviderError");
    expect(error.kind).toBe("unexpected_response");
  }),
);

it.effect("missing credentials fail per call with not_configured — and never fetch", () =>
  Effect.gen(function* () {
    const recorded: Call[] = [];
    const provider = makeMomoProvider({
      baseUrl: "https://sandbox.momodeveloper.mtn.com",
      subscriptionKey: "",
      apiUser: "",
      apiKey: "",
      targetEnv: "sandbox",
      fetchJson: (url, init) => {
        recorded.push({ url, init });
        return Promise.resolve({ status: 200, body: TOKEN_FIXTURE });
      },
    });
    const error = yield* provider.initiate(INPUT).pipe(Effect.flip);
    expect(error.kind).toBe("not_configured");
    expect(recorded).toHaveLength(0);
  }),
);

it.effect("charge input validation: integer XAF, MSISDN, non-empty reference", () =>
  Effect.gen(function* () {
    const floatAmount = yield* validateChargeInput({ ...INPUT, amountXaf: 10.5 }).pipe(Effect.flip);
    expect(floatAmount.kind).toBe("invalid_request");
    const zeroAmount = yield* validateChargeInput({ ...INPUT, amountXaf: 0 }).pipe(Effect.flip);
    expect(zeroAmount.kind).toBe("invalid_request");
    const badPhone = yield* validateChargeInput({ ...INPUT, payerPhone: "12" }).pipe(Effect.flip);
    expect(badPhone.kind).toBe("invalid_request");
    const emptyRef = yield* validateChargeInput({ ...INPUT, referenceId: "  " }).pipe(Effect.flip);
    expect(emptyRef.kind).toBe("invalid_request");
    // The happy input passes — proves the gate isn't vacuous.
    expect(yield* validateChargeInput(INPUT)).toEqual(INPUT);
    expect(yield* validateChargeInput({ ...INPUT, payerPhone: "+237651234567" })).toEqual({
      ...INPUT,
      payerPhone: "+237651234567",
    });
  }),
);

it.effect("a status response outside the contract fails as unexpected_response", () =>
  Effect.gen(function* () {
    const recorded: Call[] = [];
    const provider = makeMomoProvider(
      makeDeps(
        ({ url }) =>
          url.endsWith("/collection/token/")
            ? { status: 200, body: TOKEN_FIXTURE }
            : { status: 200, body: { status: "MAYBE" } },
        recorded,
      ),
    );
    const error = yield* provider.status(INPUT.referenceId).pipe(Effect.flip);
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error.kind).toBe("unexpected_response");
  }),
);
