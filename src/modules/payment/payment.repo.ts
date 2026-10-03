import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import type { Payment, PaymentProvider } from "@/domain/payment/payment";
import { payment } from "@/db/schema/payment";

type Row = typeof payment.$inferSelect;

const toDomain = (r: Row): Payment => ({
  id: r.id,
  appointmentId: r.appointmentId,
  payerUserId: r.payerUserId,
  provider: r.provider,
  status: r.status,
  amountXaf: r.amountXaf,
  idempotencyKey: r.idempotencyKey,
  providerChargeId: r.providerChargeId,
  providerReference: r.providerReference,
  failureReason: r.failureReason,
  receiptNumber: r.receiptNumber,
  receiptIssuedAt: r.receiptIssuedAt,
  refundedAt: r.refundedAt,
  refundReason: r.refundReason,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export interface PaymentRepoService {
  readonly insert: (row: typeof payment.$inferInsert) => Effect.Effect<Payment, SqlError.SqlError>;
  /** Plain read (no lock) — ownership checks and response mapping. */
  readonly findById: (id: string) => Effect.Effect<Payment | undefined, SqlError.SqlError>;
  /**
   * Row-lock a payment (`SELECT … FOR UPDATE`) — the serialization point for
   * webhook-vs-poll races, so a double delivery and a concurrent status poll
   * queue and the second re-reads the (already terminal) state.
   */
  readonly lockById: (id: string) => Effect.Effect<Payment | undefined, SqlError.SqlError>;
  /** Webhook lookup by the provider's handle (MoMo referenceId / Orange payToken). */
  readonly findByProviderChargeId: (
    providerChargeId: string,
  ) => Effect.Effect<Payment | undefined, SqlError.SqlError>;
  /** The appointment's most recent charge — checkout idempotency decisions. */
  readonly latestForAppointment: (
    appointmentId: string,
  ) => Effect.Effect<Payment | undefined, SqlError.SqlError>;
  /**
   * The provider accepted the charge: `initiated → pending` and the handle is
   * stored. Guarded on `status = 'initiated'` so the state machine is
   * DB-enforced even if a caller's lock were lost.
   */
  readonly markPending: (
    id: string,
    values: { readonly providerChargeId: string; readonly now: Date },
  ) => Effect.Effect<Payment | undefined, SqlError.SqlError>;
  /**
   * Guarded lifecycle transition to a TERMINAL state (`succeeded`/`failed`)
   * from `initiated`/`pending`. Returns undefined when the row is not in an
   * eligible state — that is the idempotency mechanism: a duplicate webhook
   * delivery finds nothing to change and the caller returns the row as-is.
   */
  readonly transitionToTerminal: (
    id: string,
    values: {
      readonly status: "succeeded" | "failed";
      readonly providerReference: string | null;
      readonly failureReason: string | null;
      readonly now: Date;
    },
  ) => Effect.Effect<Payment | undefined, SqlError.SqlError>;
  /**
   * Refund: `succeeded → refunded` with the audit timestamp + reason, in ONE
   * guarded write (the CHECK pins refunded ⟺ refundedAt). Eligible-state
   * guard makes a double refund a no-op-visible-to-caller, not a corruption.
   */
  readonly refund: (
    id: string,
    values: { readonly reason: string; readonly now: Date },
  ) => Effect.Effect<Payment | undefined, SqlError.SqlError>;
}

export class PaymentRepo extends Context.Tag("PaymentRepo")<PaymentRepo, PaymentRepoService>() {}

export const PaymentRepoLive = Layer.effect(
  PaymentRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    return {
      insert: (row) =>
        db
          .insert(payment)
          .values(row)
          .returning()
          .pipe(
            Effect.flatMap((rows) =>
              rows[0]
                ? Effect.succeed(toDomain(rows[0]))
                : Effect.dieMessage("Payment insert returned no row."),
            ),
          ),

      findById: (id) =>
        db
          .select()
          .from(payment)
          .where(eq(payment.id, id))
          .limit(1)
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),

      lockById: (id) =>
        db
          .select()
          .from(payment)
          .where(eq(payment.id, id))
          .limit(1)
          // Row lock held until the transaction ends — webhook/poll/refund
          // state changes serialize here (P5.T3).
          .for("update")
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),

      findByProviderChargeId: (providerChargeId) =>
        db
          .select()
          .from(payment)
          .where(eq(payment.providerChargeId, providerChargeId))
          .orderBy(desc(payment.createdAt))
          .limit(1)
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),

      latestForAppointment: (appointmentId) =>
        db
          .select()
          .from(payment)
          .where(eq(payment.appointmentId, appointmentId))
          .orderBy(desc(payment.createdAt))
          .limit(1)
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),

      markPending: (id, { providerChargeId, now }) =>
        db
          .update(payment)
          .set({ status: "pending", providerChargeId, updatedAt: now })
          .where(and(eq(payment.id, id), inArray(payment.status, ["initiated"])))
          .returning()
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),

      transitionToTerminal: (id, { status, providerReference, failureReason, now }) => {
        // Optional stamps are added only when present (no conditional spread).
        const updates: Partial<typeof payment.$inferInsert> = { status, updatedAt: now };
        if (providerReference !== null) updates.providerReference = providerReference;
        if (failureReason !== null) updates.failureReason = failureReason;
        // Receipt (P5.T4): stamped in the SAME guarded write that captures the
        // money — a receipt number exists iff the charge succeeded (CHECK:
        // receipt only when paid). The number embeds the payment id, so it is
        // unique by construction; on refund it survives (paid-then-returned).
        if (status === "succeeded") {
          updates.receiptNumber = `KS-${id}`;
          updates.receiptIssuedAt = now;
        }
        return (
          db
            .update(payment)
            .set(updates)
            // The state machine's write guard: terminal states are only
            // reachable from `initiated`/`pending`. A second delivery (or a
            // poll racing a webhook) updates zero rows — single transition.
            .where(and(eq(payment.id, id), inArray(payment.status, ["initiated", "pending"])))
            .returning()
            .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined)))
        );
      },

      refund: (id, { reason, now }) =>
        db
          .update(payment)
          .set({ status: "refunded", refundedAt: now, refundReason: reason, updatedAt: now })
          // Only a captured (succeeded) charge can be refunded.
          .where(and(eq(payment.id, id), inArray(payment.status, ["succeeded"])))
          .returning()
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),
    };
  }),
);

/** The provider rail a webhook event claims — narrowed to the DB enum's values. */
export const isPaymentProvider = (value: string): value is PaymentProvider =>
  value === "momo" || value === "orange_money";
