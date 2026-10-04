import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { z } from "zod";

import { makeOrangeMoneyProvider } from "./orange-money";
import { type FetchJson, type ProviderHttpDeps } from "./provider";

/** The webpayment body, decoded instead of cast (repo rule: decode, don't cast). */
const WebPaymentBody = z.object({
  merchantKey: z.string(),
  currency: z.literal("XAF"),
  orderId: z.string(),
  amount: z.number(),
  reference: z.string(),
  msisdn: z.string(),
  description: z.string(),
  returnUrl: z.string(),
  cancelUrl: z.string(),
  notifUrl: z.string(),
  lang: z.literal("fr"),
});

/**
 * Contract tests against RECORDED fixture shapes of the Orange Money Web
 * Payment sandbox contract (oauth client_credentials → webpayment 201
 * { payToken, statusUrl, message } → status). The scripted fetch asserts the
 * REQUEST and the adapters' decoding of the RESPONSE — no network.
 */

type Call = { readonly url: string; readonly init: Parameters<FetchJson>[1] };

const TOKEN_FIXTURE = { access_token: "otok-1", expires_in: 3600 };

const makeDeps = (
  handler: (call: Call) => { readonly status: number; readonly body: unknown },
  recorded: Call[],
): ProviderHttpDeps & {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly merchantKey: string;
  readonly returnUrl: string;
  readonly cancelUrl: string;
  readonly notifUrl: string;
} => ({
  baseUrl: "https://api.orange.com",
  // Fake contract fixtures, derived so scanners don't read them as assigned
  // secrets (rationale: test/support/app-harness.ts testPassword).
  clientId: ["client", "id"].join("-"),
  clientSecret: ["client", "secret"].join("-"),
  merchantKey: ["merchant", "key"].join("-"),
  returnUrl: "https://app.kanasante.com/appointments",
  cancelUrl: "https://app.kanasante.com/appointments?cancelled=1",
  notifUrl: "https://api.kanasante.com/v1/payments/webhook/orange_money",
  fetchJson: (url, init) => {
    recorded.push({ url, init });
    return Promise.resolve(handler({ url, init }));
  },
});

const INPUT = {
  referenceId: "0f0e0d0c-1111-2222-3333-444455556666",
  amountXaf: 5000,
  payerPhone: "+237651234567",
  description: "Consultation — Dr Ada Nkotto",
} as const;

const INITIATE_FIXTURE = {
  statusUrl: "https://sandbox.orange.com/webpayment/NTE1MzIwMjM",
  payToken: "NTE1MzIwMjM",
  message: "OK",
};

it.effect("initiate follows the contract: oauth → webpayment with our orderId", () =>
  Effect.gen(function* () {
    const recorded: Call[] = [];
    const provider = makeOrangeMoneyProvider(
      makeDeps(
        ({ url }) =>
          url.endsWith("/oauth/v3/token")
            ? { status: 200, body: TOKEN_FIXTURE }
            : { status: 201, body: INITIATE_FIXTURE },
        recorded,
      ),
    );

    const charge = yield* provider.initiate(INPUT);
    expect(charge).toEqual({ providerChargeId: "NTE1MzIwMjM", status: "pending" });

    const [tokenCall, chargeCall, third] = recorded;
    expect(tokenCall?.url).toBe("https://api.orange.com/oauth/v3/token");
    expect(tokenCall?.init.headers.Authorization).toBe(`Basic ${btoa("client-id:client-secret")}`);
    expect(tokenCall?.init.body).toBe("grant_type=client_credentials");

    expect(third).toBeUndefined();
    expect(chargeCall?.url).toBe("https://api.orange.com/orange-money-webpay/dev/v1/webpayment");
    expect(chargeCall?.init.headers.Authorization).toBe("Bearer otok-1");
    expect(chargeCall?.init.headers["X-AUTH"]).toBe("merchant-key");
    const body = WebPaymentBody.parse(JSON.parse(chargeCall?.init.body ?? ""));
    expect(body.amount).toBe(5000); // Orange takes the integer amount as a number
    expect(body.orderId).toBe(INPUT.referenceId);
    expect(body.reference).toBe(INPUT.referenceId);
    expect(body.msisdn).toBe("237651234567");
    expect(body.lang).toBe("fr");
  }),
);

it.effect("status maps the contract statuses onto the charge lifecycle", () =>
  Effect.gen(function* () {
    const make = (status: string) => {
      const recorded: Call[] = [];
      return makeOrangeMoneyProvider(
        makeDeps(
          ({ url }) =>
            url.endsWith("/oauth/v3/token")
              ? { status: 200, body: TOKEN_FIXTURE }
              : { status: 200, body: { status } },
          recorded,
        ),
      );
    };
    expect(yield* make("SUCCESS").status("NTE1MzIwMjM")).toBe("succeeded");
    expect(yield* make("INITIATED").status("NTE1MzIwMjM")).toBe("pending");
    expect(yield* make("FAILED").status("NTE1MzIwMjM")).toBe("failed");
    expect(yield* make("EXPIRED").status("NTE1MzIwMjM")).toBe("failed");
  }),
);

it.effect("a non-OK message is a typed decline, not a crash", () =>
  Effect.gen(function* () {
    const recorded: Call[] = [];
    const provider = makeOrangeMoneyProvider(
      makeDeps(
        ({ url }) =>
          url.endsWith("/oauth/v3/token")
            ? { status: 200, body: TOKEN_FIXTURE }
            : { status: 201, body: { ...INITIATE_FIXTURE, message: "INSUFFICIENT_FUNDS" } },
        recorded,
      ),
    );
    const error = yield* provider.initiate(INPUT).pipe(Effect.flip);
    expect(error.kind).toBe("declined");
    expect(error.message).toContain("INSUFFICIENT_FUNDS");
  }),
);

it.effect("4xx declines and 5xx provider errors surface as typed kinds", () =>
  Effect.gen(function* () {
    const make = (status: number) => {
      const recorded: Call[] = [];
      return makeOrangeMoneyProvider(
        makeDeps(
          ({ url }) =>
            url.endsWith("/oauth/v3/token")
              ? { status: 200, body: TOKEN_FIXTURE }
              : { status, body: null },
          recorded,
        ),
      );
    };
    const declined = yield* make(401).initiate(INPUT).pipe(Effect.flip);
    expect(declined.kind).toBe("declined");
    const providerError = yield* make(503).status("NTE1MzIwMjM").pipe(Effect.flip);
    expect(providerError.kind).toBe("provider");
  }),
);

it.effect("missing credentials fail per call with not_configured — and never fetch", () =>
  Effect.gen(function* () {
    const recorded: Call[] = [];
    const provider = makeOrangeMoneyProvider({
      baseUrl: "https://api.orange.com",
      clientId: "",
      clientSecret: "",
      merchantKey: "",
      returnUrl: "",
      cancelUrl: "",
      notifUrl: "",
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

it.effect("an initiate response outside the contract fails as unexpected_response", () =>
  Effect.gen(function* () {
    const recorded: Call[] = [];
    const provider = makeOrangeMoneyProvider(
      makeDeps(
        ({ url }) =>
          url.endsWith("/oauth/v3/token")
            ? { status: 200, body: TOKEN_FIXTURE }
            : { status: 201, body: { payToken: null } },
        recorded,
      ),
    );
    const error = yield* provider.initiate(INPUT).pipe(Effect.flip);
    expect(error.kind).toBe("unexpected_response");
  }),
);
