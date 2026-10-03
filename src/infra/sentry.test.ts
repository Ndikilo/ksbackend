import type { Envelope, Transport } from "@sentry/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { captureApiError, flushSentry, initSentry } from "./sentry";

// The parts of a Sentry event payload the assertions need, decoded with zod —
// envelope items are untyped at the transport boundary, and non-event items
// (client reports, sessions) simply fail this schema and are ignored.
const EventPayloadSchema = z.object({
  environment: z.string().optional(),
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

// Disabled-path checks must run BEFORE any test below calls initSentry with a
// DSN: the SDK keeps one process-global client.
describe("initSentry without a DSN (disabled)", () => {
  it("never initializes the SDK, and capture/flush are safe no-ops", async () => {
    const events: EventPayload[] = [];
    await initSentry({ dsn: "   ", environment: "test", transport: memoryTransport(events) });
    const mod = await import("@sentry/bun");
    expect(mod.getClient()).toBeUndefined();
    expect(() => captureApiError({ error: new Error("ignored") })).not.toThrow();
    await expect(flushSentry()).resolves.toBe(false);
    expect(events).toHaveLength(0);
  });
});

describe("initSentry with a DSN (in-memory transport)", () => {
  const events: EventPayload[] = [];

  it("routes captured errors to the transport with request id + role tags", async () => {
    await initSentry({
      dsn: "https://public@example.invalid/1",
      environment: "test",
      transport: memoryTransport(events),
    });
    captureApiError({
      error: new Error("sentry-unit-boom"),
      requestId: "req-unit-123",
      roles: ["patient"],
    });
    await expect(flushSentry()).resolves.toBe(true);

    const event = events.find((e) => e.tags?.request_id === "req-unit-123");
    expect(event).toBeDefined();
    expect(event?.environment).toBe("test");
    expect(event?.tags?.user_roles).toBe("patient");
    expect(event?.exception?.values?.some((v) => v?.value?.includes("sentry-unit-boom"))).toBe(
      true,
    );
  });

  it("omits the user_roles tag for unauthenticated errors", async () => {
    captureApiError({ error: new Error("sentry-unit-anon"), requestId: "req-unit-456" });
    await flushSentry();
    const event = events.find((e) => e.tags?.request_id === "req-unit-456");
    expect(event).toBeDefined();
    expect(event?.tags?.user_roles).toBeUndefined();
  });
});
