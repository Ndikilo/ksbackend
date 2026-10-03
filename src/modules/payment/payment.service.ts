import { SqlClient, SqlError } from "@effect/sql";
import { Clock, Config, Context, Effect, Either, Layer } from "effect";
import { z } from "zod";

import { AppointmentStateInvalid } from "@/domain/appointment/errors";
import type { Appointment } from "@/domain/appointment/appointment";
import {
  PaymentDeclined,
  PaymentProviderUnavailable,
  PaymentStateInvalid,
} from "@/domain/payment/errors";
import type { Payment, ProviderPaymentEvent } from "@/domain/payment/payment";
import { NotFound, ValidationFailed } from "@/domain/shared/errors";
import { IdGenerator } from "@/infra/ids";
import { PaymentProviderError, PaymentProviders } from "@/infra/payments/provider";
import { verifyWebhookSignature } from "@/infra/payments/webhook-signature";
import { AppointmentRepo } from "@/modules/appointment/appointment.repo";
import { PaymentRepo } from "./payment.repo";

/**
 * Checkout service (P5.T3): owns the payment state machine and its atomic tie
 * to the booking.
 *
 * - `initiate` creates a charge for a PENDING appointment (the booking's price
 *   snapshot is the charge amount) and hands it to the selected rail. The row
 *   is inserted BEFORE the provider call with a UNIQUE idempotency key, and
 *   the provider reference id IS the payment id (MoMo `X-Reference-Id`) — a
 *   retried initiate re-attaches to the same charge instead of charging twice.
 * - `applyProviderEvent` is the single state-transition funnel for both the
 *   webhook and status polling. Inside one transaction the charge flips to the
 *   terminal state (guarded write: only from `initiated`/`pending`) and — for
 *   `succeeded` — the appointment confirms (guarded write: only from
 *   `pending`). A duplicate delivery finds no eligible row, changes nothing,
 *   and returns the current state: double-delivery = single transition.
 * - `refund` (admin) flips `succeeded → refunded` and, in the same
 *   transaction, cancels the booking and frees its slot.
 *
 * Booking↔payment invariant: an appointment NEVER confirms except inside the
 * transaction that recorded a succeeded payment ("cannot confirm without
 * succeeded payment"). If the booking was cancelled while the charge was in
 * flight, the money is NOT auto-refunded — the charge lands as `succeeded`
 * against a cancelled booking and the admin refund flow returns it.
 */

export type InitiateChargeInput = {
  readonly appointmentId: string;
  readonly provider: Payment["provider"];
  readonly payerPhone: string;
};

export interface PaymentServiceService {
  /**
   * Create (or idempotently re-attach to) the charge for one appointment.
   * Caller must be the booking patient (404 otherwise). Only `pending`
   * appointments can be paid (409 APPOINTMENT_STATE_INVALID); an already
   * succeeded charge is 409 PAYMENT_STATE_INVALID; a charge still
   * `initiated`/`pending` is returned as-is (the provider call itself is
   * idempotent by the payment id); after `failed` a NEW charge may be created
   * (the retry path — same or different rail).
   */
  readonly initiate: (
    payerUserId: string,
    input: InitiateChargeInput,
  ) => Effect.Effect<
    Payment,
    | NotFound
    | AppointmentStateInvalid
    | PaymentStateInvalid
    | ValidationFailed
    | PaymentDeclined
    | PaymentProviderUnavailable
    | SqlError.SqlError
  >;
  /**
   * One charge, visible to its payer only (owner-scoped 404). While the charge
   * is still `initiated`/`pending` the provider is POLLED and any decided
   * outcome is applied through the same funnel as the webhook — this is the
   * status-polling endpoint's write path; provider trouble never fails the
   * read (the row is returned as-is instead).
   */
  readonly get: (
    payerUserId: string,
    id: string,
  ) => Effect.Effect<Payment, NotFound | SqlError.SqlError>;
  /**
   * The booking's latest charge — how the app finds the receipt data for an
   * appointment (P5.T4): the payer only (404 otherwise and when no charge
   * exists yet; the client reads "no charge" from that 404).
   */
  readonly getForAppointment: (
    payerUserId: string,
    appointmentId: string,
  ) => Effect.Effect<Payment, NotFound | SqlError.SqlError>;
  /**
   * Apply a provider-reported event (webhook payload, already
   * signature-verified and decoded). Idempotent: a duplicate or stale event
   * returns the unchanged row. Unknown providerChargeId → 404 (the provider
   * should retry delivery; we may simply not know the charge yet).
   */
  readonly applyProviderEvent: (
    event: ProviderPaymentEvent,
  ) => Effect.Effect<Payment, NotFound | SqlError.SqlError>;
  /**
   * Refund a SUCCEEDED charge (admin action): `succeeded → refunded` and the
   * booking is cancelled + its slot freed in the SAME transaction. Refunding
   * anything but a succeeded charge is 409 PAYMENT_STATE_INVALID.
   */
  readonly refund: (
    adminUserId: string,
    id: string,
    reason: string,
  ) => Effect.Effect<Payment, NotFound | PaymentStateInvalid | SqlError.SqlError>;
  /**
   * Fail-closed webhook authentication (P5.T3): true only when the raw body's
   * HMAC matches the `X-Kanasante-Signature` header. An unconfigured secret
   * rejects EVERY delivery — the endpoint is inert until `PAYMENT_WEBHOOK_SECRET`
   * is set, never open-by-default.
   */
  readonly verifyWebhook: (
    rawBody: string,
    signatureHeader: string | undefined,
  ) => Effect.Effect<boolean>;
}

export class PaymentService extends Context.Tag("PaymentService")<
  PaymentService,
  PaymentServiceService
>() {}

/** The webhook payload contract — decoded AFTER the signature check. */
export const WebhookEventSchema = z.object({
  provider: z.enum(["momo", "orange_money"]),
  providerChargeId: z.string().min(1).max(200),
  status: z.enum(["succeeded", "failed"]),
  providerReference: z.string().min(1).max(200).optional(),
  failureReason: z.string().min(1).max(500).optional(),
});

/** Translate an adapter failure into the checkout-level domain errors. */
const toCheckoutError = (
  paymentId: string,
  error: PaymentProviderError,
): PaymentDeclined | PaymentProviderUnavailable =>
  error.kind === "declined"
    ? new PaymentDeclined({ reason: error.message })
    : new PaymentProviderUnavailable({
        reason:
          error.kind === "not_configured"
            ? `${error.message} (payment row ${paymentId} stays initiated; configure the provider credentials to retry)`
            : error.message,
      });

export const PaymentServiceLive = Layer.effect(
  PaymentService,
  Effect.gen(function* () {
    const payments = yield* PaymentRepo;
    const appointments = yield* AppointmentRepo;
    const providers = yield* PaymentProviders;
    const ids = yield* IdGenerator;
    const sql = yield* SqlClient.SqlClient;

    const now: Effect.Effect<Date> = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms));

    const webhookSecret = yield* Config.string("PAYMENT_WEBHOOK_SECRET").pipe(
      Config.withDefault(""),
    );

    const providerFor = (id: Payment["provider"]) => providers[id];

    /** Drive one charge on a rail, translating adapter failures to checkout errors. */
    const initiateOnProvider = (
      provider: Payment["provider"],
      charge: { readonly id: string; readonly amountXaf: number },
      payerPhone: string,
    ) =>
      providerFor(provider)
        .initiate({
          referenceId: charge.id,
          amountXaf: charge.amountXaf,
          payerPhone,
          description: "KanaSante consultation",
        })
        .pipe(
          Effect.catchTag("PaymentProviderError", (error) =>
            Effect.fail(toCheckoutError(charge.id, error)),
          ),
        );

    const initiate = (payerUserId: string, input: InitiateChargeInput) =>
      Effect.gen(function* () {
        const at = yield* now;
        const appointment = yield* appointments.findById(input.appointmentId);
        // Owner-scoped 404: another patient's booking is indistinguishable
        // from an unknown id (codebase-wide semantics).
        if (appointment === undefined || appointment.patientUserId !== payerUserId) {
          return yield* Effect.fail(
            new NotFound({ resource: "Appointment", id: input.appointmentId }),
          );
        }
        if (appointment.status !== "pending") {
          return yield* Effect.fail(new AppointmentStateInvalid({ current: appointment.status }));
        }
        if (appointment.priceXaf <= 0) {
          return yield* Effect.fail(
            new ValidationFailed({
              issues: [{ path: "appointmentId", message: "This booking has no amount to charge." }],
            }),
          );
        }

        // Idempotency: one live charge per appointment. A charge still in
        // flight is RETURNED (the provider side is idempotent on the payment
        // id, so a client retry is safe); `succeeded` blocks re-paying;
        // `failed`/`refunded` allow a fresh charge (the retry path).
        const existing = yield* payments.latestForAppointment(appointment.id);
        if (
          existing !== undefined &&
          (existing.status === "initiated" || existing.status === "pending")
        ) {
          if (existing.status === "pending") return existing;
          // Still `initiated` — the provider never accepted (or the call never
          // completed): re-drive the SAME charge by its idempotency key.
          const retried = yield* initiateOnProvider(input.provider, existing, input.payerPhone);
          const updated = yield* payments.markPending(existing.id, {
            providerChargeId: retried.providerChargeId,
            now: at,
          });
          return updated ?? existing;
        }
        if (existing?.status === "succeeded") {
          return yield* Effect.fail(new PaymentStateInvalid({ current: existing.status }));
        }

        const charge = yield* payments.insert({
          id: yield* ids.next,
          appointmentId: appointment.id,
          payerUserId,
          provider: input.provider,
          status: "initiated",
          amountXaf: appointment.priceXaf,
          // Minted here (not by the client) and UNIQUE — the DB-level
          // double-charge backstop (P5.T2).
          idempotencyKey: yield* ids.next,
          createdAt: at,
          updatedAt: at,
        });

        // The provider's reference id IS our payment id: a retry with the same
        // reference can never double-charge (P5.T1 contract).
        const initiated = yield* initiateOnProvider(input.provider, charge, input.payerPhone);

        const pending = yield* payments.markPending(charge.id, {
          providerChargeId: initiated.providerChargeId,
          now: yield* now,
        });
        return pending ?? charge;
      });

    /**
     * The single transition funnel. Runs in one transaction:
     * lock the charge → guarded terminal write → (on success) guarded
     * appointment confirm. Concurrency (webhook racing a poll, duplicate
     * delivery) serializes on the row lock; the loser sees a terminal status
     * and short-circuits to the unchanged row.
     */
    const applyTerminalTransition = (
      charge: Payment,
      event: {
        readonly status: "succeeded" | "failed";
        readonly providerReference?: string | undefined;
        readonly failureReason?: string | undefined;
      },
    ): Effect.Effect<Payment, SqlError.SqlError> =>
      sql.withTransaction(
        Effect.gen(function* () {
          const at = yield* now;
          const locked = yield* payments.lockById(charge.id);
          if (locked === undefined) {
            return charge;
          }
          if (locked.status !== "initiated" && locked.status !== "pending") {
            // Already terminal (or refunded): the event is a duplicate or a
            // stale late delivery — single transition guarantee.
            return locked;
          }
          const updated = yield* payments.transitionToTerminal(locked.id, {
            status: event.status,
            providerReference: event.providerReference ?? null,
            failureReason:
              event.failureReason ?? (event.status === "failed" ? "The payment failed." : null),
            now: at,
          });
          const final = updated ?? locked;
          if (event.status === "succeeded") {
            // THE atomic tie: the booking confirms inside the same
            // transaction as the succeeded charge, and only from `pending`.
            // A meanwhile-cancelled booking stays cancelled — the money is
            // held for the admin refund flow.
            yield* appointments.confirmAppointment(final.appointmentId, at);
          }
          return final;
        }),
      );

    const applyProviderEvent = (event: ProviderPaymentEvent) =>
      Effect.gen(function* () {
        const charge = yield* payments.findByProviderChargeId(event.providerChargeId);
        if (charge === undefined) {
          // Unknown handle: 404 and the provider retries delivery — we may
          // simply not have committed the initiate yet.
          return yield* Effect.fail(
            new NotFound({ resource: "Payment", id: event.providerChargeId }),
          );
        }
        return yield* applyTerminalTransition(charge, event);
      });

    const get = (payerUserId: string, id: string) =>
      Effect.gen(function* () {
        const charge = yield* payments.findById(id);
        if (charge === undefined || charge.payerUserId !== payerUserId) {
          return yield* Effect.fail(new NotFound({ resource: "Payment", id }));
        }
        // Poll-and-reconcile while the outcome is undecided; provider trouble
        // must never fail the read (best-effort — the webhook is the
        // authoritative push path, this is the pull path).
        if (
          (charge.status === "initiated" || charge.status === "pending") &&
          charge.providerChargeId !== null
        ) {
          const polled = yield* Effect.either(
            providerFor(charge.provider).status(charge.providerChargeId),
          );
          if (Either.isRight(polled) && polled.right !== "pending") {
            return yield* applyTerminalTransition(charge, {
              status: polled.right,
            });
          }
        }
        return charge;
      });

    const getForAppointment = (payerUserId: string, appointmentId: string) =>
      Effect.gen(function* () {
        const appointment = yield* appointments.findById(appointmentId);
        // Owner-scoped 404: another patient's booking is indistinguishable
        // from an unknown id (codebase-wide semantics).
        if (appointment === undefined || appointment.patientUserId !== payerUserId) {
          return yield* Effect.fail(new NotFound({ resource: "Appointment", id: appointmentId }));
        }
        // "No charge yet" is the same 404 shape — the client treats any 404
        // here as "nothing to show" (the checkout flow mints the charge).
        const charge = yield* payments.latestForAppointment(appointment.id);
        if (charge === undefined) {
          return yield* Effect.fail(new NotFound({ resource: "Payment", id: appointmentId }));
        }
        // Plain read on purpose: live status reconciliation belongs to `get`
        // (the polling endpoint); this is the receipt/retrieval path.
        return charge;
      });

    const refund = (adminUserId: string, id: string, reason: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const at = yield* now;
          const locked = yield* payments.lockById(id);
          if (locked === undefined) {
            return yield* Effect.fail(new NotFound({ resource: "Payment", id }));
          }
          if (locked.status !== "succeeded") {
            return yield* Effect.fail(new PaymentStateInvalid({ current: locked.status }));
          }
          const refunded = yield* payments.refund(locked.id, { reason, now: at });
          if (refunded === undefined) {
            // Lost a race with a concurrent refund under the lock — broken
            // invariant, not a user error.
            return yield* Effect.dieMessage(
              `refund: payment ${id} was succeeded under its lock but the guarded write matched no row.`,
            );
          }
          // Undo the booking atomically: cancel (from pending/confirmed) and
          // free the slot for rebooking. An already-cancelled/completed
          // booking simply skips these guarded writes.
          const appointment: Appointment | undefined = yield* appointments.lockById(
            refunded.appointmentId,
          );
          if (appointment !== undefined) {
            const cancelled = yield* appointments.cancelAppointment(refunded.appointmentId, {
              byUserId: adminUserId,
              late: false,
              now: at,
            });
            if (cancelled !== undefined) {
              yield* appointments.markSlotOpen(appointment.slotId, at);
            }
          }
          return refunded;
        }),
      );

    return {
      initiate,
      get,
      getForAppointment,
      applyProviderEvent,
      refund,
      verifyWebhook: (rawBody, signatureHeader) =>
        Effect.sync(() => verifyWebhookSignature(webhookSecret, rawBody, signatureHeader)),
    };
  }),
);
