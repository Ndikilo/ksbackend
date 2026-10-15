import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { user } from "@/db/schema/auth";
import { appointment as appointmentTable } from "@/db/schema/appointment";
import { availabilitySlot } from "@/db/schema/availability-slot";
import { consultationOffering } from "@/db/schema/consultation-offering";
import { payment as paymentTable } from "@/db/schema/payment";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import { profession } from "@/db/schema/profession";
import { startTestPostgres } from "../support/testcontainers";

/**
 * P5.T2 — the payment table against a real Postgres (migrations applied by
 * the harness). The heart of the suite is the idempotency proof: two charge
 * inserts race on the SAME `idempotencyKey`, the unique index
 * (`payment_idempotency_key_unique`) serializes them, and EXACTLY ONE row
 * survives — the loser fails with the unique violation the checkout service
 * (P5.T3) translates into "read the existing charge". Dropping the index
 * turns the race into two winners (red: double charge). The schema guards
 * (positive amount, receipt⟺paid, refund⟺timestamp) are pinned the same way.
 */

type Db = ReturnType<typeof drizzle>;
type PaymentInsert = typeof paymentTable.$inferInsert;

/** Concatenate an Error message chain: drizzle wraps the pg rejection
 * ("Failed query: …") with the CHECK/unique violation on `cause`. */
const causeChainText = (top: Error): string => {
  const parts: string[] = [];
  let current: Error | undefined = top;
  while (current !== undefined) {
    parts.push(current.message);
    // SAFETY: ES2022 Error#cause is documented as `unknown` but holds the
    // driver's own Error here; the loop re-checks instanceof before use.
    current = current.cause as Error | undefined;
  }
  return parts.join(" | ");
};

/** Fire the inserts concurrently and classify outcomes (no user-visible throw). */
const raceInserts = async (
  db: Db,
  rows: readonly PaymentInsert[],
): Promise<{ winners: number; uniqueViolations: number }> => {
  const outcomes = await Promise.allSettled(rows.map((row) => db.insert(paymentTable).values(row)));
  let winners = 0;
  let uniqueViolations = 0;
  for (const outcome of outcomes) {
    if (outcome.status === "fulfilled") {
      winners += 1;
      continue;
    }
    if (causeChainText(outcome.reason).includes("payment_idempotency_key_unique")) {
      uniqueViolations += 1;
    } else {
      throw outcome.reason;
    }
  }
  return { winners, uniqueViolations };
};

const firstRow = async <T>(rows: readonly T[]): Promise<T> => {
  const row = rows[0];
  if (row === undefined) throw new Error("fixture query returned no rows");
  return row;
};

describe("payment table (integration) — idempotency constraint", () => {
  let db: Db;
  let stopPg: () => Promise<void>;
  let appointmentId: string;
  let payerId: string;

  beforeAll(async () => {
    const pg = await startTestPostgres();
    stopPg = pg.stop;
    db = drizzle(pg.url);

    // — Fixture chain: user → profession → practitioner → offering → slot →
    //   appointment (every payment FK must point at a real row).
    payerId = "user-payer";
    const professionId = crypto.randomUUID();
    const practitionerId = crypto.randomUUID();
    const offeringId = crypto.randomUUID();
    const slotId = crypto.randomUUID();
    appointmentId = crypto.randomUUID();
    const startsAt = new Date(Date.now() + 24 * 60 * 60_000);

    await db.insert(profession).values({ id: professionId, nameEn: "Doctor", nameFr: "Médecin" });
    await db
      .insert(user)
      .values({ id: payerId, name: "Payer", email: "payer@example.com", emailVerified: true });
    await db.insert(practitionerProfile).values({
      id: practitionerId,
      userId: payerId, // any real user row satisfies the FK in a fixture
      professionId,
    });
    await db.insert(consultationOffering).values({
      id: offeringId,
      practitionerProfileId: practitionerId,
      consultationType: "in_person",
      durationMin: 60,
      priceXaf: 5000,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(availabilitySlot).values({
      id: slotId,
      practitionerProfileId: practitionerId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      consultationTypes: ["in_person"],
    });
    await db.insert(appointmentTable).values({
      id: appointmentId,
      patientUserId: payerId,
      dependentId: null,
      practitionerProfileId: practitionerId,
      slotId,
      consultationOfferingId: offeringId,
      status: "pending",
      consultationType: "in_person",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      priceXaf: 5000,
      cancellationNoticeHours: 24,
      cancellationFeeXaf: 0,
      lateCancellation: false,
      cancelledAt: null,
      cancelledByUserId: null,
    });
  }, 120_000);

  afterAll(async () => {
    await db.$client.end();
    // End the pool BEFORE the container goes away — an idle connection
    // terminated by the server shutdown otherwise surfaces as an
    // uncaught 57P01 after the tests have passed.
    // Idle pooled connections terminated by the container shutdown emit a
    // 57P01 'error' on the pool — listen so teardown never becomes an
    // uncaught exception after the tests have passed.
    db.$client.on("error", () => {});
    await db.$client.end();
    await stopPg();
  });

  it("a double-charge race on one idempotency key yields exactly one row", async () => {
    const key = crypto.randomUUID();
    const base: PaymentInsert = {
      id: crypto.randomUUID(),
      appointmentId,
      payerUserId: payerId,
      provider: "momo",
      status: "initiated",
      amountXaf: 5000,
      idempotencyKey: key,
    };

    const { winners, uniqueViolations } = await raceInserts(db, [
      // Distinct PRIMARY keys: the collision under test is the idempotency
      // key's unique index, not the pkey (first real-DB run finding).
      { ...base, id: crypto.randomUUID(), providerChargeId: "race-a" },
      { ...base, id: crypto.randomUUID(), providerChargeId: "race-b" },
    ]);
    expect(winners).toBe(1);
    expect(uniqueViolations).toBe(1);
    const stored = await db.select().from(paymentTable).where(eq(paymentTable.idempotencyKey, key));
    expect(stored).toHaveLength(1);
    // The surviving row is a complete charge record.
    const row = await firstRow(stored);
    expect(row.amountXaf).toBe(5000);
    expect(row.provider).toBe("momo");
  });

  it("distinct idempotency keys are NOT over-blocked (retries and second charges coexist)", async () => {
    await db.insert(paymentTable).values({
      id: crypto.randomUUID(),
      appointmentId,
      payerUserId: payerId,
      provider: "orange_money",
      status: "initiated",
      amountXaf: 3000,
      idempotencyKey: crypto.randomUUID(),
    });
    await db.insert(paymentTable).values({
      id: crypto.randomUUID(),
      appointmentId,
      payerUserId: payerId,
      provider: "momo",
      status: "initiated",
      amountXaf: 5000,
      idempotencyKey: crypto.randomUUID(),
    });
    const all = await db.select().from(paymentTable);
    expect(all).toHaveLength(3); // 1 race winner + 2 distinct keys
  });

  it("schema guards: non-positive amounts, orphan receipts and timestamp-less refunds rejected", async () => {
    const charge = (overrides: Partial<PaymentInsert>): PaymentInsert => ({
      id: crypto.randomUUID(),
      appointmentId,
      payerUserId: payerId,
      provider: "momo",
      amountXaf: 5000,
      idempotencyKey: crypto.randomUUID(),
      ...overrides,
    });

    await rejectsOnConstraint(
      db.insert(paymentTable).values(charge({ amountXaf: 0 })),
      /payment_amount_positive/,
    );
    await rejectsOnConstraint(
      db.insert(paymentTable).values(charge({ status: "failed", receiptNumber: "KS-RECEIPT-1" })),
      /payment_receipt_only_when_paid/,
    );
    await rejectsOnConstraint(
      db.insert(paymentTable).values(charge({ status: "succeeded", refundedAt: new Date() })),
      /payment_refunded_has_timestamp/,
    );

    /** The insert must reject, with the named CHECK violation in its cause chain. */
    async function rejectsOnConstraint(p: Promise<unknown>, pattern: RegExp): Promise<void> {
      const text = await p.then(
        () => "",
        (rejection) => causeChainText(rejection),
      );
      // An empty chain means the insert FULFILLED — the guard did not fire.
      expect(text).not.toBe("");
      expect(text).toMatch(pattern);
    }
  });
});
