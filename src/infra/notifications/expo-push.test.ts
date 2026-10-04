import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { z } from "zod";

import { NotificationDeliveryError } from "./channel";
import { makeExpoPushSender } from "./expo-push";

/**
 * Contract tests against RECORDED fixture shapes of the Expo push API
 * (exp.host → /--/api/v2/push/send → { data: [ticket] }). The scripted fetch
 * asserts the REQUEST (url, method, auth header, JSON body) and the adapter's
 * decoding of the RESPONSE — no network, no Expo account.
 */

type Recorded = {
  readonly url: string;
  readonly body: string | undefined;
  readonly headers: Record<string, string>;
};

const PushBody = z.object({ to: z.string(), title: z.string(), body: z.string() });

const makeDeps = (
  handler: (call: {
    readonly url: string;
    readonly init: { readonly body?: string; readonly headers: Record<string, string> };
  }) => {
    readonly status: number;
    readonly body: unknown;
  },
  recorded: Recorded[],
) => ({
  baseUrl: "https://exp.host",
  // Fake fixture, derived like the other scanner-visible credentials
  // (rationale: test/support/app-harness.ts testPassword).
  accessToken: ["expo", "token", "1"].join("-"),
  fetchJson: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => {
    recorded.push({ url, body: init.body, headers: { ...init.headers } });
    return Promise.resolve(handler({ url, init }));
  },
});

const MESSAGE = {
  to: "ExpoPushToken[aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee]",
  title: "Appointment confirmed",
  bodyHtml: "<p>Tomorrow at 09:00</p>",
  bodyText: "Tomorrow at 09:00",
} as const;

const failureOf = (effect: Effect.Effect<unknown, NotificationDeliveryError>) =>
  Effect.flip(effect).pipe(Effect.map((e) => ({ kind: e.kind, message: e.message })));

/** Header lookup is case-insensitive on the wire — the assertion is too. */
const header = (headers: Record<string, string>, name: string): string | undefined =>
  Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

it.effect("send follows the contract: POST JSON with the Bearer token, ticket ok → receipt", () =>
  Effect.gen(function* () {
    const recorded: Recorded[] = [];
    const sender = makeExpoPushSender(
      makeDeps(
        () => ({ status: 200, body: { data: [{ status: "ok", id: "ticket-1" }] } }),
        recorded,
      ),
    );

    const receipt = yield* sender.send(MESSAGE);
    expect(receipt.providerMessageId).toBe("ticket-1");

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.url).toBe("https://exp.host/--/api/v2/push/send");
    expect(header(recorded[0]?.headers ?? {}, "authorization")).toBe("Bearer expo-token-1");
    expect(PushBody.parse(JSON.parse(recorded[0]?.body ?? "{}"))).toEqual({
      to: MESSAGE.to,
      title: MESSAGE.title,
      body: MESSAGE.bodyText, // push takes the plain text, not the HTML
    });
  }),
);

it.effect("a non-Expo token is invalid_request with NO fetch made", () =>
  Effect.gen(function* () {
    const recorded: unknown[] = [];
    const sender = makeExpoPushSender({
      baseUrl: "https://exp.host",
      accessToken: "t",
      fetchJson: (url, init) => {
        recorded.push({ url, init });
        return Promise.resolve({ status: 200, body: { data: [{ status: "ok", id: "x" }] } });
      },
    });

    const failure = yield* failureOf(sender.send({ ...MESSAGE, to: "+237690000000" }));
    expect(failure.kind).toBe("invalid_request");
    expect(recorded).toHaveLength(0);
  }),
);

it.effect("an error ticket fails invalid_request with the provider's message", () =>
  Effect.gen(function* () {
    const sender = makeExpoPushSender(
      makeDeps(
        () => ({
          status: 200,
          body: { data: [{ status: "error", message: "device is not a valid push target" }] },
        }),
        [],
      ),
    );

    const failure = yield* failureOf(sender.send(MESSAGE));
    expect(failure.kind).toBe("invalid_request");
    expect(failure.message).toBe("device is not a valid push target");
  }),
);

it.effect("HTTP trouble (5xx) is kind=provider, not unexpected_response", () =>
  Effect.gen(function* () {
    const sender = makeExpoPushSender(makeDeps(() => ({ status: 503, body: null }), []));
    const failure = yield* failureOf(sender.send(MESSAGE));
    expect(failure.kind).toBe("provider");
  }),
);

it.effect("a 2xx body outside the contract is unexpected_response", () =>
  Effect.gen(function* () {
    const sender = makeExpoPushSender(
      makeDeps(() => ({ status: 200, body: { unexpected: true } }), []),
    );
    const failure = yield* failureOf(sender.send(MESSAGE));
    expect(failure.kind).toBe("unexpected_response");
  }),
);

it.effect("without an access token the request carries no Authorization header", () =>
  Effect.gen(function* () {
    const recorded: Recorded[] = [];
    const sender = makeExpoPushSender({
      baseUrl: "https://exp.host",
      accessToken: "",
      fetchJson: (url, init) => {
        recorded.push({ url, body: init.body, headers: { ...init.headers } });
        return Promise.resolve({ status: 200, body: { data: [{ status: "ok", id: "t2" }] } });
      },
    });

    yield* sender.send(MESSAGE);
    expect(header(recorded[0]?.headers ?? {}, "authorization")).toBeUndefined();
  }),
);
