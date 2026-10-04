import type { SqlError } from "@effect/sql";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { user } from "@/db/schema/auth";
import { notificationOutbox } from "@/db/schema/notification-outbox";
import {
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_STALL_TIMEOUT_MS,
  retryDelayMs,
} from "@/domain/notification/outbox";
import {
  NotificationChannels,
  NotificationDeliveryError,
  type NotificationChannelSender,
} from "@/infra/notifications/channel";
import { IdGeneratorLive } from "@/infra/ids";
import { OutboxRepoLive } from "@/modules/outbox/outbox.repo";
import { OutboxService, OutboxServiceLive } from "@/modules/outbox/outbox.service";
import { databaseLayerFromUrl, startTestPostgres } from "../support/testcontainers";

/**
 * P6.T1 — the outbox service against a real Postgres. The channels are a
 * SCRIPTED FAKE (each test bends delivery at will); what is proven HERE:
 *
 * - enqueue → drain delivers through the right channel and stamps
 *   `sent` + the provider's handle (the happy path);
 * - a channel failure records a `failed` row (attempts, lastError, a BACKOFF
 *   availableAt) instead of throwing — and the row is re-claimed only once its
 *   backoff window passes; the retry budget ends in terminal `dead`;
 * - failed/dead sends stay VISIBLE through `failures()`;
 * - a `pending` row scheduled for the future is NOT claimed early;
 * - a row stuck `sending` past the stall timeout is RECLAIMED (a crash mid-
 *   send must not strand a notification) while a FRESH `sending` row is not;
 * - concurrent drains claim DISJOINT rows (FOR UPDATE SKIP LOCKED): every
 *   notification is delivered exactly once across workers.
 *
 * The per-channel wire contracts (Expo push / Twilio / email) are pinned
 * Docker-free by their own fixture tests (infra/notifications/*.test.ts).
 */

type Service = Effect.Effect.Success<typeof OutboxService>;
type OutboxRow = typeof notificationOutbox.$inferSelect;

describe("notification outbox (real DB)", () => {
  let stopPg: () => Promise<void>;
  let runtime: ManagedRuntime.ManagedRuntime<OutboxService, SqlError.SqlError>;
  let service: Service;
  let db: ReturnType<typeof drizzle>;

  /** Scripted channel behaviour + every accepted send, for cross-checks. */
  let deliverable: boolean;
  const sends: { readonly channel: string; readonly to: string }[] = [];

  const sender = (channel: string): NotificationChannelSender => ({
    send: (message) =>
      deliverable
        ? Effect.sync(() => {
            sends.push({ channel, to: message.to });
            return { providerMessageId: `prov-${sends.length}` };
          })
        : Effect.fail(
            new NotificationDeliveryError({
              kind: "provider",
              message: `scripted outage on ${channel}`,
            }),
          ),
  });

  const ChannelsFake = Layer.succeed(NotificationChannels, {
    email: sender("email"),
    push: sender("push"),
    sms: sender("sms"),
  });

  // These tests never pass a dedupKey, so enqueue always yields a row — the
  // new `undefined` (deduplicated) outcome is guarded out of the type (P6.T2).
  const enqueueRow = (overrides?: Partial<Parameters<Service["enqueue"]>[0]>) =>
    Effect.flatMap(
      service.enqueue({
        userId: "user-outbox-1",
        channel: "email",
        category: "appointments",
        scenario: "booking_confirmation",
        locale: "en",
        recipient: "patient@example.com",
        payload: {
          title: "Appointment confirmed",
          bodyText: "Tomorrow at 09:00.",
          bodyHtml: "<p>Tomorrow at 09:00.</p>",
        },
        ...overrides,
      }),
      (row) =>
        row === undefined ? Effect.die("unexpected enqueue duplicate") : Effect.succeed(row),
    );

  /** Force a row's clock (backoff expiry / stall simulation) from the test. */
  const setRow = async (
    id: string,
    values: Partial<typeof notificationOutbox.$inferInsert>,
  ): Promise<void> => {
    await db.update(notificationOutbox).set(values).where(eq(notificationOutbox.id, id));
  };

  const rowsOf = async (id: string): Promise<OutboxRow[]> =>
    db.select().from(notificationOutbox).where(eq(notificationOutbox.id, id));

  beforeAll(async () => {
    const pg = await startTestPostgres();
    stopPg = pg.stop;
    db = drizzle(pg.url);
    const Database = databaseLayerFromUrl(pg.url);
    runtime = ManagedRuntime.make(
      OutboxServiceLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            OutboxRepoLive.pipe(Layer.provide(Database)),
            IdGeneratorLive,
            ChannelsFake,
            Database,
          ),
        ),
      ),
    );
    service = await runtime.runPromise(OutboxService);

    await db.insert(user).values({
      id: "user-outbox-1",
      name: "Outbox User",
      email: "outbox@example.com",
      emailVerified: true,
    });

    deliverable = true;
  }, 120_000);

  afterAll(async () => {
    await runtime.dispose();
    await stopPg();
  });

  it("enqueue → drain delivers through the channel and stamps the row `sent`", async () => {
    const row = await Effect.runPromise(enqueueRow());

    const summary = await Effect.runPromise(service.drain({ limit: 10 }));
    expect(summary).toEqual({ claimed: 1, sent: 1, failed: 0, dead: 0 });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toEqual({ channel: "email", to: "patient@example.com" });

    const rows = await rowsOf(row.id);
    expect(rows[0]?.status).toBe("sent");
    expect(rows[0]?.providerMessageId).toBe("prov-1");
    expect(rows[0]?.sentAt).not.toBeNull();
    // Terminal: draining again does nothing.
    const again = await Effect.runPromise(service.drain({ limit: 10 }));
    expect(again.claimed).toBe(0);
    expect(sends).toHaveLength(1);
  });

  it("a channel failure records `failed` with backoff, retries after it, and dies at the budget", async () => {
    const row = await Effect.runPromise(enqueueRow());

    deliverable = false;
    const first = await Effect.runPromise(service.drain({ limit: 10 }));
    expect(first).toEqual({ claimed: 1, sent: 0, failed: 1, dead: 0 });

    const afterFirst = (await rowsOf(row.id))[0];
    expect(afterFirst?.status).toBe("failed");
    expect(afterFirst?.attempts).toBe(1);
    expect(afterFirst?.lastError).toBe("scripted outage on email");
    // Backoff: availableAt sits exactly retryDelayMs(1) past updatedAt — the
    // pure policy and the write agree.
    const backoffMs =
      afterFirst === undefined
        ? 0
        : afterFirst.availableAt.getTime() - afterFirst.updatedAt.getTime();
    expect(backoffMs).toBe(retryDelayMs(1));

    // Before the backoff expires, nothing is claimed.
    const tooEarly = await Effect.runPromise(service.drain({ limit: 10 }));
    expect(tooEarly.claimed).toBe(0);

    // The backoff expires → the retry happens and (still down) fails again.
    await setRow(row.id, { availableAt: new Date(Date.now() - 1) });
    await Effect.runPromise(service.drain({ limit: 10 }));
    expect((await rowsOf(row.id))[0]?.attempts).toBe(2);

    // Burn the rest of the budget: every retry fails until the row goes DEAD.
    for (let attempt = 3; attempt <= OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      await setRow(row.id, { availableAt: new Date(Date.now() - 1) });
      await Effect.runPromise(service.drain({ limit: 10 }));
    }
    const dead = (await rowsOf(row.id))[0];
    expect(dead?.status).toBe("dead");
    expect(dead?.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    // Dead is terminal — no further claims, no further sends.
    const settled = await Effect.runPromise(service.drain({ limit: 10 }));
    expect(settled.claimed).toBe(0);

    // …and the failure is VISIBLE (failed sends must be observable).
    const failures = await Effect.runPromise(service.failures(10));
    expect(failures.map((f) => f.id)).toContain(row.id);
    deliverable = true;
  });

  it("a row scheduled for the future is not claimed early", async () => {
    await Effect.runPromise(enqueueRow({ availableAt: new Date(Date.now() + 60 * 60_000) }));
    const summary = await Effect.runPromise(service.drain({ limit: 10 }));
    expect(summary.claimed).toBe(0);
  });

  it("a row stuck `sending` past the stall timeout is reclaimed (crash recovery)", async () => {
    const row = await Effect.runPromise(enqueueRow());
    // Simulate a crash mid-send: the claim happened, the result never did —
    // and the claim is old enough that the stall window has passed.
    await setRow(row.id, {
      status: "sending",
      updatedAt: new Date(Date.now() - OUTBOX_STALL_TIMEOUT_MS - 1_000),
    });

    const summary = await Effect.runPromise(service.drain({ limit: 10 }));
    expect(summary.sent).toBe(1);

    const recovered = (await rowsOf(row.id))[0];
    expect(recovered?.status).toBe("sent");
    expect(recovered?.providerMessageId).not.toBeNull();
  });

  it("a freshly-stuck `sending` row inside the stall window is NOT reclaimed", async () => {
    const row = await Effect.runPromise(enqueueRow());
    await setRow(row.id, { status: "sending", updatedAt: new Date() });

    const summary = await Effect.runPromise(service.drain({ limit: 10 }));
    expect(summary.claimed).toBe(0);
  });

  it("concurrent drains claim DISJOINT rows — no notification is sent twice", async () => {
    const total = 8;
    const ids: string[] = [];
    for (let i = 0; i < total; i += 1) {
      const row = await Effect.runPromise(enqueueRow({ recipient: `patient-${i}@example.com` }));
      ids.push(row.id);
    }

    const sendsBefore = sends.length;
    const results = await Effect.runPromise(
      Effect.all([service.drain({ limit: total }), service.drain({ limit: total })], {
        mode: "either",
      }),
    );
    const claimedTotal = results.reduce(
      (acc, result) => (result._tag === "Right" ? acc + result.right.claimed : acc),
      0,
    );
    expect(claimedTotal).toBe(total);

    // Every row delivered exactly once across the two workers.
    const rows = await db.select().from(notificationOutbox);
    const delivered = rows.filter((r) => ids.includes(r.id));
    expect(delivered.every((r) => r.status === "sent")).toBe(true);
    const handles = delivered.map((r) => r.providerMessageId);
    expect(new Set(handles).size).toBe(total);
    // Exactly `total` sends fired — no double delivery.
    expect(sends.length - sendsBefore).toBe(total);
  });
});
