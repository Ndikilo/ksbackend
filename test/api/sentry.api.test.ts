import type { Envelope, Transport } from "@sentry/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestHarness, type TestHarness } from "../support/app-harness";
import { flushSentry, initSentry } from "@/infra/sentry";

// The parts of a Sentry event payload the assertions need, decoded with zod —
// envelope items are untyped at the transport boundary, and non-event items
// (client reports, sessions) simply fail this schema and are ignored.
const EventPayloadSchema = z.object({
  tags: z
    .object({
      request_id: z.string().optional(),
      user_roles: z.string().optional(),
    })
    .optional(),
  exception: z
    .object({
      values: z.array(z.object({ value: z.string().optional() })).optional(),
    })
    .optional(),
});
type EventPayload = z.infer<typeof EventPayloadSchema>;

/** In-memory transport: decodes + records every event payload the SDK hands over. */
const memoryTransport = (events: EventPayload[]) => (): Transport => ({
  send: async (envelope: Envelope) => {
    for (const item of envelope[1]) {
      const decoded = EventPayloadSchema.safeParse(item[1]);
      if (decoded.success) events.push(decoded.data);
    }
    return { statusCode: 200 };
  },
  flush: async () => true,
});

// SAFETY: every /test-only/boom response is the standard error envelope.
const requestIdOf = async (res: Response): Promise<string> =>
  (await (res.json() as Promise<{ requestId: string }>)).requestId;

// Errors thrown inside a real route must reach the configured transport, tagged
// so events correlate with the error envelope (requestId) and the caller's roles.
describe("sentry error reporting (real DB)", () => {
  const events: EventPayload[] = [];
  let harness: TestHarness;

  beforeAll(async () => {
    await initSentry({
      dsn: "https://public@example.invalid/1",
      environment: "test",
      transport: memoryTransport(events),
    });
    harness = await createTestHarness(undefined, undefined, { throwingRoute: true });
  });

  afterAll(async () => {
    await harness.dispose();
    await flushSentry();
  });

  it("reports an unauthenticated 500 with the response's requestId tag", async () => {
    const res = await harness.app.request("/test-only/boom");
    expect(res.status).toBe(500);
    const requestId = await requestIdOf(res);
    await expect(flushSentry()).resolves.toBe(true);

    const event = events.find((e) => e.tags?.request_id === requestId);
    expect(event).toBeDefined();
    expect(event?.tags?.user_roles).toBeUndefined();
    expect(
      event?.exception?.values?.some((v) => v?.value?.includes("test-only throwing route")),
    ).toBe(true);
  });

  it("tags an authenticated 500 with the caller's roles", async () => {
    const cookie = await harness.signUpAndVerify(
      "sentry.api@example.com",
      "sup3r-secret-pw",
      "Sentry Api",
    );
    const res = await harness.app.request("/test-only/boom", { headers: { cookie } });
    expect(res.status).toBe(500);
    const requestId = await requestIdOf(res);
    await expect(flushSentry()).resolves.toBe(true);

    const event = events.find((e) => e.tags?.request_id === requestId);
    expect(event).toBeDefined();
    expect(event?.tags?.user_roles).toBe("patient");
  });
});
