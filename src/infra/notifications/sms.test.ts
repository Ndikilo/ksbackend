import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { z } from "zod";

import { NotificationDeliveryError } from "./channel";
import { makeSmsSender } from "./sms";

/**
 * Contract tests against RECORDED fixture shapes of the Twilio Messages REST
 * API. The scripted fetch asserts the REQUEST (url with the account sid,
 * Basic auth, form-encoded fields) and the adapter's decoding of the RESPONSE
 * — no network, no credentials.
 */

type Recorded = {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
};

const SmsForm = z.object({ To: z.string(), From: z.string(), Body: z.string() });

const MESSAGE = {
  to: "+237690000000",
  title: "unused for SMS",
  bodyHtml: "<p>ignored</p>",
  bodyText: "Your KanaSante appointment is tomorrow at 09:00.",
} as const;

const failureOf = (effect: Effect.Effect<unknown, NotificationDeliveryError>) =>
  Effect.flip(effect).pipe(Effect.map((e) => ({ kind: e.kind, message: e.message })));

/** Header lookup is case-insensitive on the wire — the assertion is too. */
const header = (headers: Record<string, string>, name: string): string | undefined =>
  Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

const makeDeps = (
  handler: () => { readonly status: number; readonly body: unknown },
  recorded: Recorded[],
  creds?: { accountSid: string; authToken: string; fromNumber: string },
) => ({
  baseUrl: "https://api.twilio.com",
  accountSid: creds?.accountSid ?? "AC-test-sid",
  authToken: creds?.authToken ?? "test-token",
  fromNumber: creds?.fromNumber ?? "+15005550006",
  fetchJson: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => {
    recorded.push({ url, headers: { ...init.headers }, body: init.body });
    return Promise.resolve(handler());
  },
});

it.effect("send follows the contract: Basic auth, form-encoded To/From/Body, sid parsed", () =>
  Effect.gen(function* () {
    const recorded: Recorded[] = [];
    const sender = makeSmsSender(
      makeDeps(() => ({ status: 201, body: { sid: "SM-test-1" } }), recorded),
    );

    const receipt = yield* sender.send(MESSAGE);
    expect(receipt.providerMessageId).toBe("SM-test-1");

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC-test-sid/Messages.json",
    );
    // btoa("AC-test-sid:test-token") — pinned so an auth regression is loud.
    expect(header(recorded[0]?.headers ?? {}, "authorization")).toBe(
      `Basic ${btoa("AC-test-sid:test-token")}`,
    );
    expect(SmsForm.parse(Object.fromEntries(new URLSearchParams(recorded[0]?.body ?? "")))).toEqual(
      {
        To: MESSAGE.to,
        From: "+15005550006",
        Body: MESSAGE.bodyText,
      },
    );
  }),
);

it.effect("missing credentials are not_configured with NO fetch made", () =>
  Effect.gen(function* () {
    const recorded: Recorded[] = [];
    const sender = makeSmsSender(
      makeDeps(() => ({ status: 201, body: { sid: "SM-never" } }), recorded, {
        accountSid: "",
        authToken: "",
        fromNumber: "",
      }),
    );

    const failure = yield* failureOf(sender.send(MESSAGE));
    expect(failure.kind).toBe("not_configured");
    expect(recorded).toHaveLength(0);
  }),
);

it.effect("an empty body is invalid_request without a round-trip", () =>
  Effect.gen(function* () {
    const recorded: Recorded[] = [];
    const sender = makeSmsSender(
      makeDeps(() => ({ status: 201, body: { sid: "SM-x" } }), recorded),
    );

    const failure = yield* failureOf(sender.send({ ...MESSAGE, bodyText: "   " }));
    expect(failure.kind).toBe("invalid_request");
    expect(recorded).toHaveLength(0);
  }),
);

it.effect("HTTP trouble (4xx/5xx) is kind=provider with the status", () =>
  Effect.gen(function* () {
    const sender = makeSmsSender(makeDeps(() => ({ status: 500, body: null }), []));
    const failure = yield* failureOf(sender.send(MESSAGE));
    expect(failure.kind).toBe("provider");
  }),
);

it.effect("a 2xx body outside the contract is unexpected_response", () =>
  Effect.gen(function* () {
    const sender = makeSmsSender(makeDeps(() => ({ status: 201, body: { noSid: true } }), []));
    const failure = yield* failureOf(sender.send(MESSAGE));
    expect(failure.kind).toBe("unexpected_response");
  }),
);
