import { Effect, Layer, ManagedRuntime } from "effect";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { user } from "@/db/schema/auth";
import { appointment as appointmentTable } from "@/db/schema/appointment";
import { availabilitySlot } from "@/db/schema/availability-slot";
import { consultationOffering } from "@/db/schema/consultation-offering";
import { notificationOutbox } from "@/db/schema/notification-outbox";
import { notificationPreference } from "@/db/schema/notification-preference";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import { profession } from "@/db/schema/profession";
import {
  NotificationChannels,
  type NotificationChannelSender,
} from "@/infra/notifications/channel";
import { IdGeneratorLive } from "@/infra/ids";
import { OutboxRepoLive } from "@/modules/outbox/outbox.repo";
import { OutboxServiceLive } from "@/modules/outbox/outbox.service";
import { ReminderRepoLive } from "@/modules/reminder/reminder.repo";
import {
  ReminderScheduler,
  ReminderSchedulerLive,
  type ReminderRunSummary,
} from "@/modules/reminder/reminder.service";
import { databaseLayerFromUrl, startTestPostgres } from "../support/testcontainers";

/**
 * P6.T2 — the reminder scheduler against a real Postgres. What is proven
 * HERE (the pure window table + the orchestration are Docker-free):
 *
 * - CONCURRENCY: two scheduler runtimes over two independent connection
 *   pools race one scan pass — the outbox dedup key (UNIQUE index +
 *   ON CONFLICT DO NOTHING) keeps EXACTLY ONE row per (appointment, horizon).
 *   Dropping the dedup key would double-enqueue (red); dropping the index
 *   would crash the loser with a unique-violation (red).
 * - The full loop delivers: enqueued reminders are drained and SENT through
 *   the email channel in the same pass, with the rendered copy.
 * - Cancelled-before-send appointments are skipped; preference rows gate the
 *   enqueue; appointments outside the window are not scanned.
 */

const NOW = new Date("2026-06-10T09:00:00.000Z");

/** One scheduler pass on the given runtime (shared by both racing pools). */
const runPassOn =
  (runtime: {
    readonly runPromise: <A, E>(effect: Effect.Effect<A, E, ReminderScheduler>) => Promise<A>;
  }) =>
  (now: Date): Promise<ReminderRunSummary> =>
    runtime.runPromise(Effect.flatMap(ReminderScheduler, (service) => service.run({ now })));

describe("reminder scheduler (integration)", () => {
  let stopPg: () => Promise<void>;
  let db: ReturnType<typeof drizzle>;
  type SchedulerRuntime = ReturnType<typeof makeSchedulerRuntime>;
  let runtimeA: SchedulerRuntime;
  let runtimeB: SchedulerRuntime;
  let runOnA: (now: Date) => Promise<ReminderRunSummary>;
  let runOnB: (now: Date) => Promise<ReminderRunSummary>;

  const sends: Array<{
    readonly channel: string;
    readonly to: string;
    readonly title: string;
    readonly bodyText: string;
  }> = [];
  const sender = (channel: string): NotificationChannelSender => ({
    send: (message) =>
      Effect.sync(() => {
        sends.push({ channel, to: message.to, title: message.title, bodyText: message.bodyText });
        return { providerMessageId: `prov-${sends.length}` };
      }),
  });
  const ChannelsFake = Layer.succeed(NotificationChannels, {
    email: sender("email"),
    push: sender("push"),
    sms: sender("sms"),
  });

  let pgUrl: string;

  /** An independent scheduler runtime (its own pool) over the same database. */
  const makeSchedulerRuntime = () => {
    const Database = databaseLayerFromUrl(pgUrl);
    return ManagedRuntime.make(
      ReminderSchedulerLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            ReminderRepoLive.pipe(Layer.provide(Database)),
            OutboxServiceLive.pipe(
              Layer.provide(
                Layer.mergeAll(
                  OutboxRepoLive.pipe(Layer.provide(Database)),
                  ChannelsFake,
                  IdGeneratorLive,
                  Database,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  };

  /** One appointment with its slot, starting `startsAt`, booked at `createdAt`. */
  const seedAppointment = async (input: {
    readonly id: string;
    readonly patientUserId: string;
    readonly startsAt: Date;
    readonly createdAt: Date;
    readonly status?: "confirmed" | "cancelled" | "pending";
    /** Required when status is "cancelled" (appointment_cancelled_has_timestamp). */
    readonly cancelledAt?: Date;
  }) => {
    const slotId = crypto.randomUUID();
    await db.insert(availabilitySlot).values({
      id: slotId,
      practitionerProfileId: practitionerId,
      startsAt: input.startsAt,
      endsAt: new Date(input.startsAt.getTime() + 60 * 60_000),
      consultationTypes: ["in_person"],
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(appointmentTable).values({
      id: input.id,
      patientUserId: input.patientUserId,
      practitionerProfileId: practitionerId,
      slotId,
      consultationOfferingId: offeringId,
      status: input.status ?? "confirmed",
      consultationType: "in_person",
      startsAt: input.startsAt,
      endsAt: new Date(input.startsAt.getTime() + 60 * 60_000),
      priceXaf: 5000,
      cancellationNoticeHours: 24,
      cancellationFeeXaf: 0,
      cancelledAt: input.cancelledAt ?? null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
  };

  const allRows = async () => db.select().from(notificationOutbox);

  let practitionerId: string;
  let offeringId: string;
  const patientDefault = "user-patient-default";
  const patientNoEmail = "user-patient-no-email";

  beforeAll(async () => {
    const pg = await startTestPostgres();
    stopPg = pg.stop;
    pgUrl = pg.url;
    db = drizzle(pg.url);

    const professionId = crypto.randomUUID();
    await db.insert(profession).values({ id: professionId, nameEn: "Doctor", nameFr: "Médecin" });
    await db.insert(user).values([
      {
        id: "user-practitioner",
        name: "Dr Etta Nkoro",
        email: "practitioner@example.com",
        emailVerified: true,
        role: "practitioner",
      },
      {
        id: patientDefault,
        name: "Default Patient",
        email: "default@example.com",
        emailVerified: true,
      },
      {
        id: patientNoEmail,
        name: "Quiet Patient",
        email: "quiet@example.com",
        emailVerified: true,
      },
    ]);
    practitionerId = crypto.randomUUID();
    await db.insert(practitionerProfile).values({
      id: practitionerId,
      userId: "user-practitioner",
      professionId,
    });
    offeringId = crypto.randomUUID();
    await db.insert(consultationOffering).values({
      id: offeringId,
      practitionerProfileId: practitionerId,
      consultationType: "in_person",
      durationMin: 60,
      priceXaf: 5000,
      createdAt: NOW,
      updatedAt: NOW,
    });
    // The quiet patient disabled every channel for the appointments category
    // (the stored preference matrix row the scheduler must consult).
    await db.insert(notificationPreference).values({
      id: crypto.randomUUID(),
      userId: patientNoEmail,
      category: "appointments",
      email: false,
      sms: false,
      push: false,
      createdAt: NOW,
      updatedAt: NOW,
    });

    runtimeA = makeSchedulerRuntime();
    runtimeB = makeSchedulerRuntime();
    runOnA = runPassOn(runtimeA);
    runOnB = runPassOn(runtimeB);
  }, 120_000);

  afterAll(async () => {
    await runtimeA.dispose();
    await runtimeB.dispose();
    await db.$client.end();
    await stopPg();
  });

  it("two racing scheduler passes enqueue EXACTLY ONE row per (appointment, horizon)", async () => {
    // Boundary case: the appointment is EXACTLY 24h out — the 24h reminder is
    // due right now, the 1h reminder not yet. Booked long before the window.
    await seedAppointment({
      id: crypto.randomUUID(),
      patientUserId: patientDefault,
      startsAt: new Date(NOW.getTime() + 24 * 60 * 60_000),
      createdAt: new Date(NOW.getTime() - 48 * 60 * 60_000),
    });

    const [summaryA, summaryB] = await Promise.all([
      runOnA(NOW),
      runOnB(NOW), // independent pool, same database, same due candidate
    ]);

    // Exactly ONE row survives the race — whichever pass INSERTed first.
    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dedupKey).toMatch(/^reminder-24h:/);
    expect(rows[0]?.scenario).toBe("reminder-24h");
    // …and it was drained and delivered in that very pass.
    expect(rows[0]?.status).toBe("sent");

    // One pass won the INSERT; the other observed the duplicate (no crash).
    expect(summaryA.enqueued + summaryB.enqueued).toBe(1);
    expect(summaryA.duplicates + summaryB.duplicates).toBe(1);
  });

  it("delivers the rendered reminder through the email channel in-pass", async () => {
    const reminder = sends.find((s) => s.channel === "email" && s.to === "default@example.com");
    expect(reminder).toBeDefined();
    // Clinic-local time, never the server's: 09:00Z = 10:00 in Douala.
    expect(reminder?.title).toContain("10:00");
    expect(reminder?.bodyText).toContain("Dr Etta Nkoro");
    expect(reminder?.bodyText).not.toMatch(/emails\.|\{when\}|\{practitioner\}/);
  });

  it("skips cancelled appointments and honours the stored preference matrix", async () => {
    await seedAppointment({
      id: crypto.randomUUID(),
      patientUserId: patientDefault,
      startsAt: new Date(NOW.getTime() + 30 * 60_000),
      createdAt: new Date(NOW.getTime() - 48 * 60 * 60_000),
      status: "cancelled",
      // The CHECK pins cancelled ⇔ a timestamp — a cancelled row without one
      // is uninsertable (first real-DB run finding).
      cancelledAt: new Date(NOW.getTime() - 60_000),
    });
    // Both horizons are due for this one — but its user disabled every
    // channel for the appointments category, so nothing may enqueue.
    await seedAppointment({
      id: crypto.randomUUID(),
      patientUserId: patientNoEmail,
      // 31 minutes out: both horizons are still due, and the distinct window
      // avoids the (practitioner, starts_at) unique index — NOW is a FIXED
      // base, so same-offset seeds would collide (first real-DB run finding).
      startsAt: new Date(NOW.getTime() + 31 * 60_000),
      createdAt: new Date(NOW.getTime() - 48 * 60 * 60_000),
    });

    const summary = await runOnA(NOW);

    expect(summary.enqueued).toBe(0);
    // The cancelled appointment is excluded at the SCAN QUERY (candidates are
    // confirmed-only), so it never reaches the horizon judge — `skipped`
    // counts judge-level skips (started / booked-too-late), not cancellations.
    expect(summary.skipped).toBe(0);
    const rows = await allRows();
    // Still exactly the ONE row from the race test — nothing new went out.
    expect(rows).toHaveLength(1);
  });

  it("an appointment outside the widest horizon is not scanned at all", async () => {
    await seedAppointment({
      id: crypto.randomUUID(),
      patientUserId: patientDefault,
      startsAt: new Date(NOW.getTime() + 3 * 24 * 60 * 60_000),
      createdAt: new Date(NOW.getTime() - 48 * 60 * 60_000),
    });
    const summary = await runOnA(NOW);
    // Scanned = rows inside (now, now+24h]: the cancelled + muted pair from
    // the previous test; the 3-days-out appointment did NOT enter the scan.
    expect(summary.scanned).toBe(2);
    expect(summary.enqueued).toBe(0);
    const rows = await allRows();
    expect(rows).toHaveLength(1);
  });
});
