import type { ConsultationType } from "@/domain/practitioner/practitioner";

/**
 * Payment status machine (P5.T2/P5.T3): `initiated → pending → succeeded |
 * failed`, and `succeeded → refunded`. `initiated` = the checkout row exists
 * but the provider has not (yet) accepted the charge; `pending` = the provider
 * accepted it and the wallet is awaiting confirmation; the terminal states
 * come from the provider via webhook or status polling. The value set is
 * DB-pinned (`payment_status_enum`).
 */
export const PAYMENT_STATUSES = [
  "initiated",
  "pending",
  "succeeded",
  "failed",
  "refunded",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Which mobile-money rail the charge runs on (mirrors `payment_provider_enum`). */
export const PAYMENT_PROVIDERS = ["momo", "orange_money"] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

/**
 * A mobile-money charge against one appointment. Money is INTEGER XAF — no
 * floats anywhere in the payment path. The checkout service (P5.T3) owns the
 * state machine: an appointment confirms ONLY inside the same transaction that
 * flips its charge to `succeeded` (the atomic booking↔payment tie), and a
 * refund flips both the charge and the appointment back in one transaction.
 */
export type Payment = {
  readonly id: string;
  readonly appointmentId: string;
  /** The account holder who initiated the charge (dependents don't pay). */
  readonly payerUserId: string;
  readonly provider: PaymentProvider;
  readonly status: PaymentStatus;
  readonly amountXaf: number;
  /** Caller-minted (service-minted) uuid — UNIQUE; the double-charge backstop. */
  readonly idempotencyKey: string;
  /** Provider handle to poll (MoMo referenceId / Orange payToken). */
  readonly providerChargeId: string | null;
  /** Raw provider reference for reconciliation (financialTransactionId, …). */
  readonly providerReference: string | null;
  /** Why the charge failed (provider code or message). */
  readonly failureReason: string | null;
  // Receipt (P5.T4): stamped iff the charge succeeded.
  readonly receiptNumber: string | null;
  readonly receiptIssuedAt: Date | null;
  // Refund bookkeeping: set iff status = 'refunded' (CHECK-pinned).
  readonly refundedAt: Date | null;
  readonly refundReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** The consultation type a charge pays for — snapshot copy for the provider. */
export type ChargeDescription = {
  readonly consultationType: ConsultationType;
  readonly startsAt: Date;
};

/**
 * A provider-reported lifecycle event (webhook body or poll result) in
 * platform-canonical form — the raw provider callbacks are adapted into this
 * shape by the checkout layer before any state changes.
 */
export type ProviderPaymentEvent = {
  readonly provider: PaymentProvider;
  readonly providerChargeId: string;
  readonly status: "succeeded" | "failed";
  readonly providerReference?: string | undefined;
  /** Provider-reported failure detail, stamped onto the row when it fails. */
  readonly failureReason?: string | undefined;
};
