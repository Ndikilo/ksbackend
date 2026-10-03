import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth";
import { appointment } from "./appointment";
import { paymentProviderEnum, paymentStatusEnum } from "./enums";

/**
 * A mobile-money charge against one appointment (P5.T2). The checkout service
 * (P5.T3) owns the state machine: initiated → pending → succeeded/failed, and
 * succeeded → refunded (refund support, P5.T3). Money is INTEGER XAF — no
 * floats anywhere in the payment path (P5.T6).
 *
 * Idempotency: `idempotencyKey` is caller-generated (the checkout layer mints
 * one per charge attempt) and UNIQUE — a retried initiate (double-tap, webhook
 * re-delivery racing the poll, provider timeout) re-attaches to the SAME row
 * instead of charging twice. The unique index is the database-level backstop;
 * the service must treat a unique violation as "read the existing charge".
 *
 * Receipt fields (`receiptNumber`/`receiptIssuedAt`) are stamped by the
 * receipt flow (P5.T4) once a charge succeeds.
 */
export const payment = pgTable(
  "payment",
  {
    id: uuid("id").primaryKey(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointment.id, { onDelete: "cascade" }),
    // The wallet holder of record — the patient account that initiated the
    // charge (dependents don't pay; their guardian does).
    payerUserId: text("payer_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: paymentProviderEnum("provider").notNull(),
    status: paymentStatusEnum("status").notNull().default("initiated"),
    amountXaf: integer("amount_xaf").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    // Provider handle to poll (MoMo referenceId / Orange payToken) — set once
    // the provider accepted the initiate call. Raw provider references for
    // reconciliation live here too (MoMo financialTransactionId, Orange
    // notifToken, …) so support can match rows against provider dashboards.
    providerChargeId: text("provider_charge_id"),
    providerReference: text("provider_reference"),
    // Why a charge failed (localized-safe code or provider message).
    failureReason: text("failure_reason"),
    // Receipt (P5.T4): stamped iff the charge succeeded.
    receiptNumber: text("receipt_number"),
    receiptIssuedAt: timestamp("receipt_issued_at", { withTimezone: true }),
    // Refund bookkeeping (P5.T3): set iff status = 'refunded'.
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    refundReason: text("refund_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // FK columns are join/delete hot paths (P0.T7 discipline).
    index("payment_appointment_id_idx").on(t.appointmentId),
    index("payment_payer_user_id_idx").on(t.payerUserId),
    index("payment_provider_charge_id_idx").on(t.providerChargeId),
    // THE idempotency constraint: one charge per key, ever.
    uniqueIndex("payment_idempotency_key_unique").on(t.idempotencyKey),
    check("payment_amount_positive", sql`${t.amountXaf} > 0`),
    // refunded ⟺ refundedAt: the timestamp is the audit anchor of the refund.
    check(
      "payment_refunded_has_timestamp",
      sql`(${t.status} = 'refunded') = (${t.refundedAt} is not null)`,
    ),
    // Receipt ⟺ success: a receipt number can only exist on a succeeded or
    // refunded (paid-then-returned) charge.
    check(
      "payment_receipt_only_when_paid",
      sql`${t.receiptNumber} is null or ${t.status} in ('succeeded', 'refunded')`,
    ),
  ],
);
