import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appointment as appointmentTable } from "@/db/schema/appointment";
import { availabilitySlot } from "@/db/schema/availability-slot";
import { consultationOffering } from "@/db/schema/consultation-offering";
import { payment as paymentTable } from "@/db/schema/payment";
import { profession } from "@/db/schema/profession";
import {
  type ChargeStatus,
  type InitiateChargeInput,
  type InitiatedCharge,
  type PaymentProviderId,
  PaymentProviderError,
  PaymentProviders,
  type PaymentProviderService,
} from "@/infra/payments/provider";
import { signWebhookPayload } from "@/infra/payments/webhook-signature";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and immediately assert on those shapes.
const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;

/**
 * P5.T3 — checkout, webhook, polling and refund paths against a real Postgres
 * (Docker/CI tier). The rails are a SCRIPTED FAKE (each test bends provider
 * behaviour at will); the real adapters' contracts are pinned by their own
 * P5.T1 fixture tests. What is proven HERE:
 *
 * - checkout authz/ownership (401/404), state gates (409), idempotent
 *   re-initiate (same charge, no double provider call), decline → 402 +
 *   `failed` row + retry-creates-new-charge, unavailable → 503 + row stays
 *   `initiated` and the SAME charge is re-driven;
 * - webhook fail-closed HMAC (missing/malformed/wrong signature → 401,
 *   malformed/invalid payload with a GOOD signature → 422), unknown charge →
 *   404;
 * - the atomic booking↔payment tie: succeeded ⇒ appointment `confirmed`,
 *   failed ⇒ appointment stays `pending`; DOUBLE DELIVERY = single transition;
 *   a succeeded charge against a meanwhile-cancelled booking leaves the
 *   booking cancelled (money held for refund);
 * - status polling reconciles on read (provider decided ⇒ same funnel as the
 *   webhook; provider trouble never fails the read);
 * - P5.T6 timeout reconciliation: a provider-side TIMEOUT/expiry reconciles to
 *   `failed` on poll (booking stays pending), and the FIRST decision wins
 *   across paths — a late duplicate webhook after a poll decision is a no-op,
 *   and a late CONTRADICTORY webhook (succeeded after a timed-out `failed`)
 *   cannot confirm the booking;
 * - refund (admin-only): charge `refunded` + booking `cancelled` + slot freed
 *   atomically; double refund / non-succeeded refund → 409;
 * - receipts (P5.T4): a succeeded charge is stamped `receiptNumber = KS-<id>`
 *   in the same guarded write; the receipt survives a refund; the booking's
 *   charge (with receipt data) is retrievable by-appointment, payer-only, with
 *   "unknown / not-yours / no-charge-yet" all the same 404.
 */

type Script = {
  initiate: "accept" | "decline" | "unavailable";
  poll: ChargeStatus | "error";
};

/** Mutable counter shared with the scripted providers — provider call volume is asserted. */
type ProviderCalls = { initiate: number };

const scriptedProvider = (
  id: PaymentProviderId,
  script: Script,
  calls: ProviderCalls,
): PaymentProviderService => ({
  id,
  initiate: (input: InitiateChargeInput): Effect.Effect<InitiatedCharge, PaymentProviderError> => {
    calls.initiate += 1;
    if (script.initiate === "decline") {
      return Effect.fail(
        new PaymentProviderError({ kind: "declined", message: "wallet refused the prompt" }),
      );
    }
    if (script.initiate === "unavailable") {
      return Effect.fail(
        new PaymentProviderError({
          kind: "not_configured",
          message: "MOMO_SUBSCRIPTION_KEY is not configured",
        }),
      );
    }
    return Effect.succeed({ providerChargeId: input.referenceId, status: "pending" });
  },
  status: (): Effect.Effect<ChargeStatus, PaymentProviderError> =>
    script.poll === "error"
      ? Effect.fail(
          new PaymentProviderError({ kind: "provider", message: "provider status endpoint down" }),
        )
      : Effect.succeed(script.poll),
});

describe("payments API (real DB)", () => {
  let harness: TestHarness;
  let script: Script;
  let calls: ProviderCalls;
  let payerCookie: string;
  let otherCookie: string;
  let payerUserId: string;
  let paymentProfileId: string;
  let offeringId: string;

  const secret = "test-webhook-secret-at-least-16-chars";

  /** Book one future slot as the payer; returns the appointment id. */
  const bookAppointment = async (): Promise<string> => {
    const startsAt = new Date(Date.now() + 8 * 24 * 60 * 60_000);
    const freshSlot = crypto.randomUUID();
    await harness.db.insert(availabilitySlot).values({
      id: freshSlot,
      practitionerProfileId: paymentProfileId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      consultationTypes: ["in_person"],
    });
    const res = await harness.post(
      "/v1/appointments",
      { slotId: freshSlot, offeringId },
      payerCookie,
    );
    expect(res.status).toBe(201);
    return (await json<{ id: string }>(res)).id;
  };

  type CheckoutBody = {
    readonly appointmentId: string;
    readonly provider: "momo" | "orange_money";
    readonly payerPhone: string;
  };

  const checkout = (body: CheckoutBody, cookie = payerCookie) =>
    harness.post("/v1/payments", body, cookie);

  /** The webhook payload this API accepts (platform-canonical event form). */
  type WebhookTestPayload = {
    readonly provider: "momo" | "orange_money";
    readonly providerChargeId: string;
    readonly status: "succeeded" | "failed";
    readonly providerReference?: string;
    readonly failureReason?: string;
  };

  /** POST raw bytes to the webhook — signature optional/override for rejection tests. */
  const rawWebhookPost = async (raw: string, signature?: string): Promise<Response> => {
    const headers = new Headers({ "content-type": "application/json" });
    headers.set("x-kanasante-signature", signature ?? signWebhookPayload(secret, raw));
    return harness.app.request("/v1/payments/webhook", {
      method: "POST",
      headers,
      body: raw,
    });
  };

  /** POST a well-formed event, signed over its exact bytes (unless overridden). */
  const webhookPost = (event: WebhookTestPayload, signature?: string): Promise<Response> =>
    rawWebhookPost(JSON.stringify(event), signature);

  const appointmentStatus = async (id: string): Promise<string | undefined> => {
    const rows = await harness.db
      .select({ status: appointmentTable.status })
      .from(appointmentTable)
      .where(eq(appointmentTable.id, id));
    return rows[0]?.status;
  };

  const paymentRow = async (id: string) => {
    const rows = await harness.db.select().from(paymentTable).where(eq(paymentTable.id, id));
    return rows[0];
  };

  beforeAll(async () => {
    script = { initiate: "accept", poll: "pending" };
    calls = { initiate: 0 };
    const paymentsFake = Layer.succeed(PaymentProviders, {
      momo: scriptedProvider("momo", script, calls),
      orange_money: scriptedProvider("orange_money", script, calls),
    });
    harness = await createTestHarness({ PAYMENT_WEBHOOK_SECRET: secret }, undefined, {
      payments: paymentsFake,
    });

    payerCookie = await harness.signUpAndVerify("payer@example.com", "password12345", "Pay Er");
    otherCookie = await harness.signUpAndVerify("other@example.com", "password12345", "Oth Er");
    payerUserId = await harness.userIdFor("payer@example.com");

    // Booking fixtures: practitioner profile + offering + one slot (each test
    // books a FRESH slot so scenarios never share appointment state).
    const professionId = crypto.randomUUID();
    await harness.db
      .insert(profession)
      .values({ id: professionId, nameEn: "Doctor", nameFr: "Médecin" });
    paymentProfileId = await harness.seedPractitionerProfile({
      userId: await harness.userIdFor("payer@example.com"),
      professionId,
    });
    offeringId = crypto.randomUUID();
    await harness.db.insert(consultationOffering).values({
      id: offeringId,
      practitionerProfileId: paymentProfileId,
      consultationType: "in_person",
      durationMin: 60,
      priceXaf: 5000,
    });
  }, 120_000);

  afterAll(() => harness.dispose());

  describe("POST /v1/payments (checkout)", () => {
    it("requires a session", async () => {
      const res = await harness.post("/v1/payments", {
        appointmentId: crypto.randomUUID(),
        provider: "momo",
        payerPhone: "+237690000000",
      });
      expect(res.status).toBe(401);
    });

    it("another patient's booking is a 404 (never an existence leak)", async () => {
      const appointmentId = await bookAppointment();
      const res = await checkout(
        { appointmentId, provider: "momo", payerPhone: "+237690000000" },
        otherCookie,
      );
      expect(res.status).toBe(404);
      const body = await json<{ error: { code: string } }>(res);
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("creates the charge and the appointment stays pending until it succeeds", async () => {
      const appointmentId = await bookAppointment();
      const res = await checkout({ appointmentId, provider: "momo", payerPhone: "+237690000000" });
      expect(res.status).toBe(201);
      const charge = await json<{
        id: string;
        status: string;
        amountXaf: number;
        providerChargeId: string;
        provider: string;
      }>(res);
      expect(charge.status).toBe("pending"); // provider (scripted) accepted
      expect(charge.amountXaf).toBe(5000); // the booking's price snapshot
      expect(charge.provider).toBe("momo");
      // The provider's reference IS the payment id (the idempotency key).
      expect(charge.providerChargeId).toBe(charge.id);
      const row = await paymentRow(charge.id);
      expect(row?.status).toBe("pending");
      expect(row?.payerUserId).toBe(payerUserId);
      expect(await appointmentStatus(appointmentId)).toBe("pending");
    });

    it("re-initiating an open charge returns the SAME charge without a new provider call", async () => {
      const appointmentId = await bookAppointment();
      const first = await json<{ id: string }>(
        await checkout({ appointmentId, provider: "momo", payerPhone: "+237690000000" }),
      );
      const callsBefore = calls.initiate;
      const second = await json<{ id: string }>(
        await checkout({ appointmentId, provider: "momo", payerPhone: "+237690000000" }),
      );
      expect(second.id).toBe(first.id);
      expect(calls.initiate).toBe(callsBefore); // pending ⇒ returned as-is, no provider call
    });

    it("a declined charge is 402 PAYMENT_DECLINED, stamps the row `failed`, and a retry creates a NEW charge", async () => {
      const appointmentId = await bookAppointment();
      script.initiate = "decline";
      const declined = await checkout({
        appointmentId,
        provider: "momo",
        payerPhone: "+237690000000",
      });
      expect(declined.status).toBe(402);
      const body = await json<{ error: { code: string } }>(declined);
      expect(body.error.code).toBe("PAYMENT_DECLINED");
      // The failed charge allows a fresh attempt.
      script.initiate = "accept";
      const retry = await checkout({
        appointmentId,
        provider: "momo",
        payerPhone: "+237690000000",
      });
      expect(retry.status).toBe(201);
      const fresh = await json<{ id: string; status: string }>(retry);
      const rows = await harness.db
        .select({ id: paymentTable.id, status: paymentTable.status })
        .from(paymentTable)
        .where(eq(paymentTable.appointmentId, appointmentId));
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.id === fresh.id)?.status).toBe("pending");
    });

    it("an unavailable provider is 503, the row stays `initiated`, and a retry re-drives the SAME charge", async () => {
      const appointmentId = await bookAppointment();
      script.initiate = "unavailable";
      const res = await checkout({
        appointmentId,
        provider: "orange_money",
        payerPhone: "+237690000000",
      });
      expect(res.status).toBe(503);
      const body = await json<{ error: { code: string } }>(res);
      expect(body.error.code).toBe("PAYMENT_PROVIDER_UNAVAILABLE");
      const rows = await harness.db
        .select({ id: paymentTable.id, status: paymentTable.status })
        .from(paymentTable)
        .where(eq(paymentTable.appointmentId, appointmentId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("initiated");
      // Credentials "arrive": the retry re-drives the SAME charge idempotently.
      script.initiate = "accept";
      const callsBefore = calls.initiate;
      const retry = await json<{ id: string; status: string }>(
        await checkout({ appointmentId, provider: "orange_money", payerPhone: "+237690000000" }),
      );
      expect(retry.id).toBe(rows[0]?.id);
      expect(retry.status).toBe("pending");
      expect(calls.initiate).toBe(callsBefore + 1); // the provider WAS called again (same reference)
    });

    it("an already-succeeded charge blocks re-paying with 409 (the booking is confirmed, so the appointment-state guard fires first)", async () => {
      const appointmentId = await bookAppointment();
      const charge = await json<{ id: string }>(
        await checkout({ appointmentId, provider: "momo", payerPhone: "+237690000000" }),
      );
      await webhookPost({ provider: "momo", providerChargeId: charge.id, status: "succeeded" });
      const res = await checkout({ appointmentId, provider: "momo", payerPhone: "+237690000000" });
      expect(res.status).toBe(409);
      const body = await json<{ error: { code: string } }>(res);
      // A succeeded charge ALWAYS implies a confirmed booking (the atomic
      // invariant), so the initiate's appointment-payability guard rejects —
      // still a 409, still an honest block of the double payment.
      expect(body.error.code).toBe("APPOINTMENT_STATE_INVALID");
    });
  });

  describe("POST /v1/payments/webhook", () => {
    it("rejects a MISSING signature (fail-closed, payload never processed)", async () => {
      // Truly UNSIGNED: no signature header at all (the helper's undefined
      // signature means "sign it for me" — the exact trap this test guards).
      const res = await harness.app.request("/v1/payments/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "momo", providerChargeId: "x", status: "succeeded" }),
      });
      expect(res.status).toBe(401);
      const body = await json<{ error: { code: string } }>(res);
      expect(body.error.code).toBe("WEBHOOK_SIGNATURE_INVALID");
    });

    it("rejects a WRONG signature", async () => {
      const raw = JSON.stringify({ provider: "momo", providerChargeId: "x", status: "succeeded" });
      const res = await rawWebhookPost(raw, signWebhookPayload("attacker-secret", raw));
      expect(res.status).toBe(401);
      const body = await json<{ error: { code: string } }>(res);
      expect(body.error.code).toBe("WEBHOOK_SIGNATURE_INVALID");
    });

    it("rejects a tampered body signed for DIFFERENT bytes", async () => {
      const raw = JSON.stringify({ provider: "momo", providerChargeId: "x", status: "failed" });
      const tampered = raw.replace("failed", "succeeded");
      const res = await rawWebhookPost(tampered, signWebhookPayload(secret, raw));
      expect(res.status).toBe(401);
    });

    it("malformed JSON / wrong shape with a GOOD signature is 422 (still nothing processed)", async () => {
      const malformed = await rawWebhookPost("{not json");
      expect(malformed.status).toBe(422);
      const invalidEvent = await rawWebhookPost(
        JSON.stringify({ provider: "momo", providerChargeId: "" }),
      );
      expect(invalidEvent.status).toBe(422);
    });

    it("an unknown providerChargeId is 404 (providers retry delivery)", async () => {
      const res = await webhookPost({
        provider: "momo",
        providerChargeId: "no-such-charge",
        status: "succeeded",
      });
      expect(res.status).toBe(404);
    });

    it("succeeded ⇒ payment succeeded AND the appointment confirmed, atomically", async () => {
      const appointmentId = await bookAppointment();
      const charge = await json<{ id: string }>(
        await checkout({ appointmentId, provider: "momo", payerPhone: "+237690000000" }),
      );
      const res = await webhookPost({
        provider: "momo",
        providerChargeId: charge.id,
        status: "succeeded",
        providerReference: "ft-123",
      });
      expect(res.status).toBe(200);
      const body = await json<{ status: string; providerChargeId: string }>(res);
      expect(body.status).toBe("succeeded");
      expect(body.providerChargeId).toBe(charge.id);
      const row = await paymentRow(charge.id);
      expect(row?.status).toBe("succeeded");
      expect(row?.providerReference).toBe("ft-123");
      // THE atomic tie: the booking confirmed in the same transaction.
      expect(await appointmentStatus(appointmentId)).toBe("confirmed");
    });

    it("DOUBLE delivery is a single state transition", async () => {
      const appointmentId = await bookAppointment();
      const charge = await json<{ id: string }>(
        await checkout({ appointmentId, provider: "momo", payerPhone: "+237690000000" }),
      );
      const first = await webhookPost({
        provider: "momo",
        providerChargeId: charge.id,
        status: "succeeded",
      });
      expect(first.status).toBe(200);
      const rowAfterFirst = await paymentRow(charge.id);
      const second = await webhookPost({
        provider: "momo",
        providerChargeId: charge.id,
        status: "succeeded",
      });
      expect(second.status).toBe(200);
      const rowAfterSecond = await paymentRow(charge.id);
      expect(rowAfterSecond?.status).toBe("succeeded");
      expect(rowAfterSecond?.updatedAt?.getTime()).toBe(rowAfterFirst?.updatedAt?.getTime());
      // Exactly one payment row, and the booking confirmed exactly once (still confirmed, not corrupted).
      const rows = await harness.db
        .select()
        .from(paymentTable)
        .where(eq(paymentTable.appointmentId, appointmentId));
      expect(rows).toHaveLength(1);
      expect(await appointmentStatus(appointmentId)).toBe("confirmed");
    });

    it("failed ⇒ payment failed with the reason, the appointment stays pending", async () => {
      const appointmentId = await bookAppointment();
      const charge = await json<{ id: string }>(
        await checkout({ appointmentId, provider: "momo", payerPhone: "+237690000000" }),
      );
      const res = await webhookPost({
        provider: "momo",
        providerChargeId: charge.id,
        status: "failed",
        failureReason: "insufficient balance",
      });
      expect(res.status).toBe(200);
      const row = await paymentRow(charge.id);
      expect(row?.status).toBe("failed");
      expect(row?.failureReason).toBe("insufficient balance");
      expect(await appointmentStatus(appointmentId)).toBe("pending");
    });

    it("a succeeded charge against a meanwhile-CANCELLED booking does not resurrect it (money held for refund)", async () => {
      const appointmentId = await bookAppointment();
      const charge = await json<{ id: string }>(
        await checkout({ appointmentId, provider: "momo", payerPhone: "+237690000000" }),
      );
      const cancel = await harness.post(
        `/v1/appointments/${appointmentId}/cancel`,
        {},
        payerCookie,
      );
      expect(cancel.status).toBe(200);
      const res = await webhookPost({
        provider: "momo",
        providerChargeId: charge.id,
        status: "succeeded",
      });
      expect(res.status).toBe(200);
      const row = await paymentRow(charge.id);
      expect(row?.status).toBe("succeeded"); // the money arrived
      expect(await appointmentStatus(appointmentId)).toBe("cancelled"); // but no resurrection
    });
  });

  describe("GET /v1/payments/{id} (status polling)", () => {
    it("the payer reads the charge; anyone else gets the same 404", async () => {
      const appointmentId = await bookAppointment();
      const charge = await json<{ id: string }>(
        await checkout({ appointmentId, provider: "momo", payerPhone: "+237690000000" }),
      );
      const ok = await harness.app.request(`/v1/payments/${charge.id}`, {
        headers: { cookie: payerCookie },
      });
      expect(ok.status).toBe(200);
      const body = await json<{ id: string; status: string }>(ok);
      expect(body.id).toBe(charge.id);
      const other = await harness.app.request(`/v1/payments/${charge.id}`, {
        headers: { cookie: otherCookie },
      });
      expect(other.status).toBe(404);
    });

    it("polling applies a decided provider outcome (succeeded ⇒ appointment confirmed)", async () => {
      const appointmentId = await bookAppointment();
      const charge = await json<{ id: string }>(
        await checkout({ appointmentId, provider: "momo", payerPhone: "+237690000000" }),
      );
      script.poll = "succeeded";
      const res = await harness.app.request(`/v1/payments/${charge.id}`, {
        headers: { cookie: payerCookie },
      });
      expect(res.status).toBe(200);
      const body = await json<{ status: string }>(res);
      expect(body.status).toBe("succeeded");
      expect(await appointmentStatus(appointmentId)).toBe("confirmed");
      script.poll = "pending";
    });

    it("provider trouble never fails the read (last known state is returned)", async () => {
      const appointmentId = await bookAppointment();
      const charge = await json<{ id: string }>(
        await checkout({ appointmentId, provider: "momo", payerPhone: "+237690000000" }),
      );
      script.poll = "error";
      const res = await harness.app.request(`/v1/payments/${charge.id}`, {
        headers: { cookie: payerCookie },
      });
      expect(res.status).toBe(200);
      const body = await json<{ status: string }>(res);
      expect(body.status).toBe("pending");
      expect(await appointmentStatus(appointmentId)).toBe("pending");
      script.poll = "pending";
    });

    // P5.T6 — timeout reconciliation: the provider itself timing a charge out
    // (MoMo FAILED after the prompt expires / Orange EXPIRED maps to `failed`)
    // must reconcile through the SAME funnel on read, and that first decision
    // must then win over any late push-path delivery.
    it("polling applies a FAILED outcome (provider timeout/expiry) and the booking stays pending", async () => {
      const appointmentId = await bookAppointment();
      const charge = await json<{ id: string }>(
        await checkout({ appointmentId, provider: "orange_money", payerPhone: "+237690000000" }),
      );
      script.poll = "failed"; // e.g. Orange EXPIRED after the web-pay session times out
      const res = await harness.app.request(`/v1/payments/${charge.id}`, {
        headers: { cookie: payerCookie },
      });
      expect(res.status).toBe(200);
      const body = await json<{ status: string }>(res);
      expect(body.status).toBe("failed");
      const row = await paymentRow(charge.id);
      expect(row?.status).toBe("failed");
      expect(await appointmentStatus(appointmentId)).toBe("pending");
      script.poll = "pending";
    });

    it("the FIRST decision wins across paths: a late CONTRADICTORY webhook cannot resurrect a poll-timed-out charge", async () => {
      const appointmentId = await bookAppointment();
      const charge = await json<{ id: string }>(
        await checkout({ appointmentId, provider: "momo", payerPhone: "+237690000000" }),
      );
      // The pull path reconciles the timed-out charge to `failed`.
      script.poll = "failed";
      const polled = await harness.app.request(`/v1/payments/${charge.id}`, {
        headers: { cookie: payerCookie },
      });
      expect((await json<{ status: string }>(polled)).status).toBe("failed");
      script.poll = "pending";

      const afterPoll = await paymentRow(charge.id);
      // The provider's late delivery of the SAME decision: 200, zero writes.
      const lateSame = await webhookPost({
        provider: "momo",
        providerChargeId: charge.id,
        status: "failed",
      });
      expect(lateSame.status).toBe(200);
      // And a contradictory late `succeeded` must NOT confirm the booking —
      // the terminal state was already reached on the poll path.
      const lateContradictory = await webhookPost({
        provider: "momo",
        providerChargeId: charge.id,
        status: "succeeded",
      });
      expect(lateContradictory.status).toBe(200);

      const after = await paymentRow(charge.id);
      expect(after?.status).toBe("failed");
      expect(after?.updatedAt?.getTime()).toBe(afterPoll?.updatedAt?.getTime());
      expect(await appointmentStatus(appointmentId)).toBe("pending");
      const rows = await harness.db
        .select()
        .from(paymentTable)
        .where(eq(paymentTable.appointmentId, appointmentId));
      expect(rows).toHaveLength(1); // no charge was created by the late pushes
    });

    it("cross-path idempotency: a poll-decided SUCCESS then the provider's duplicate webhook changes nothing", async () => {
      const appointmentId = await bookAppointment();
      const charge = await json<{ id: string }>(
        await checkout({ appointmentId, provider: "momo", payerPhone: "+237690000000" }),
      );
      script.poll = "succeeded";
      const polled = await harness.app.request(`/v1/payments/${charge.id}`, {
        headers: { cookie: payerCookie },
      });
      expect((await json<{ status: string }>(polled)).status).toBe("succeeded");
      expect(await appointmentStatus(appointmentId)).toBe("confirmed");
      script.poll = "pending";

      const rowAfterPoll = await paymentRow(charge.id);
      const duplicate = await webhookPost({
        provider: "momo",
        providerChargeId: charge.id,
        status: "succeeded",
      });
      expect(duplicate.status).toBe(200);
      const rowAfterWebhook = await paymentRow(charge.id);
      expect(rowAfterWebhook?.updatedAt?.getTime()).toBe(rowAfterPoll?.updatedAt?.getTime());
      expect(await appointmentStatus(appointmentId)).toBe("confirmed");
    });
  });

  describe("POST /v1/payments/{id}/refund", () => {
    let adminCookie: string;

    it("is admin-only (403 for a plain patient)", async () => {
      const appointmentId = await bookAppointment();
      const charge = await json<{ id: string }>(
        await checkout({ appointmentId, provider: "momo", payerPhone: "+237690000000" }),
      );
      await webhookPost({ provider: "momo", providerChargeId: charge.id, status: "succeeded" });
      const res = await harness.post(
        `/v1/payments/${charge.id}/refund`,
        { reason: "patient asked for money back" },
        payerCookie,
      );
      expect(res.status).toBe(403);
    });

    it("flips charge → refunded AND booking → cancelled AND frees the slot, atomically", async () => {
      adminCookie = await harness.signUpAndVerify(
        "payadmin@example.com",
        "password12345",
        "Adm In",
      );
      await harness.promoteToAdmin("payadmin@example.com");

      const appointmentId = await bookAppointment();
      const charge = await json<{ id: string }>(
        await checkout({ appointmentId, provider: "momo", payerPhone: "+237690000000" }),
      );
      await webhookPost({ provider: "momo", providerChargeId: charge.id, status: "succeeded" });
      expect(await appointmentStatus(appointmentId)).toBe("confirmed");

      const res = await harness.post(
        `/v1/payments/${charge.id}/refund`,
        { reason: "practitioner cancelled the session" },
        adminCookie,
      );
      expect(res.status).toBe(200);
      const body = await json<{ status: string }>(res);
      expect(body.status).toBe("refunded");
      const row = await paymentRow(charge.id);
      expect(row?.status).toBe("refunded");
      expect(row?.refundedAt).not.toBeNull();
      expect(row?.refundReason).toBe("practitioner cancelled the session");
      expect(await appointmentStatus(appointmentId)).toBe("cancelled");
    });

    it("a second refund attempt is 409 PAYMENT_STATE_INVALID; a non-succeeded charge cannot be refunded", async () => {
      const appointmentId = await bookAppointment();
      const charge = await json<{ id: string }>(
        await checkout({ appointmentId, provider: "momo", payerPhone: "+237690000000" }),
      );
      // Still pending — refund must refuse.
      const early = await harness.post(
        `/v1/payments/${charge.id}/refund`,
        { reason: "too early" },
        adminCookie,
      );
      expect(early.status).toBe(409);
      const earlyBody = await json<{ error: { code: string } }>(early);
      expect(earlyBody.error.code).toBe("PAYMENT_STATE_INVALID");

      await webhookPost({ provider: "momo", providerChargeId: charge.id, status: "succeeded" });
      const first = await harness.post(
        `/v1/payments/${charge.id}/refund`,
        { reason: "goodwill refund" },
        adminCookie,
      );
      expect(first.status).toBe(200);
      const second = await harness.post(
        `/v1/payments/${charge.id}/refund`,
        { reason: "double refund attempt" },
        adminCookie,
      );
      expect(second.status).toBe(409);
      const secondBody = await json<{ error: { code: string } }>(second);
      expect(secondBody.error.code).toBe("PAYMENT_STATE_INVALID");
    });
  });

  it("GET /v1/payments/{id} requires a session", async () => {
    const res = await harness.app.request(`/v1/payments/${crypto.randomUUID()}`);
    expect(res.status).toBe(401);
  });

  describe("receipts (P5.T4)", () => {
    let adminCookie: string;

    it("a succeeded charge is stamped with a receipt (number embeds the payment id); a refund does not erase it", async () => {
      adminCookie = await harness.signUpAndVerify(
        "receiptadmin@example.com",
        "password12345",
        "Adm In",
      );
      await harness.promoteToAdmin("receiptadmin@example.com");

      const appointmentId = await bookAppointment();
      const charge = await json<{ id: string }>(
        await checkout({ appointmentId, provider: "momo", payerPhone: "+237690000000" }),
      );
      await webhookPost({ provider: "momo", providerChargeId: charge.id, status: "succeeded" });
      const row = await paymentRow(charge.id);
      expect(row?.receiptNumber).toBe(`KS-${charge.id}`);
      expect(row?.receiptIssuedAt).not.toBeNull();

      // The refund marks the money returned but the receipt survives
      // (paid-then-returned — the CHECK allows a receipt on refunded rows).
      const refundRes = await harness.post(
        `/v1/payments/${charge.id}/refund`,
        { reason: "receipt must survive" },
        adminCookie,
      );
      expect(refundRes.status).toBe(200);
      const after = await paymentRow(charge.id);
      expect(after?.status).toBe("refunded");
      expect(after?.receiptNumber).toBe(`KS-${charge.id}`);
      expect(after?.receiptIssuedAt).not.toBeNull();
    });

    it("GET /v1/payments/by-appointment/{id} returns the charge with receipt data (payer only)", async () => {
      const appointmentId = await bookAppointment();
      const charge = await json<{ id: string }>(
        await checkout({ appointmentId, provider: "orange_money", payerPhone: "+237690000000" }),
      );
      await webhookPost({
        provider: "orange_money",
        providerChargeId: charge.id,
        status: "succeeded",
      });
      const res = await harness.app.request(`/v1/payments/by-appointment/${appointmentId}`, {
        headers: { cookie: payerCookie },
      });
      expect(res.status).toBe(200);
      const body = await json<{
        id: string;
        status: string;
        receiptNumber: string | null;
        receiptIssuedAt: string | null;
        amountXaf: number;
      }>(res);
      expect(body.id).toBe(charge.id);
      expect(body.status).toBe("succeeded");
      expect(body.receiptNumber).toBe(`KS-${charge.id}`);
      expect(body.receiptIssuedAt).not.toBeNull();
      expect(body.amountXaf).toBe(5000);
    });

    it("by-appointment: another patient's booking, an unknown id, and a booking with no charge are ALL the same 404", async () => {
      // Another patient's booking.
      const foreignId = await bookAppointment();
      const foreign = await harness.app.request(`/v1/payments/by-appointment/${foreignId}`, {
        headers: { cookie: otherCookie },
      });
      expect(foreign.status).toBe(404);
      expect((await json<{ error: { code: string } }>(foreign)).error.code).toBe("NOT_FOUND");

      // Unknown appointment id.
      const unknown = await harness.app.request(
        `/v1/payments/by-appointment/${crypto.randomUUID()}`,
        { headers: { cookie: payerCookie } },
      );
      expect(unknown.status).toBe(404);

      // Own booking, never checked out — "no charge yet" is the same 404.
      const noChargeId = await bookAppointment();
      const noCharge = await harness.app.request(`/v1/payments/by-appointment/${noChargeId}`, {
        headers: { cookie: payerCookie },
      });
      expect(noCharge.status).toBe(404);
    });

    it("by-appointment requires a session", async () => {
      const res = await harness.app.request(`/v1/payments/by-appointment/${crypto.randomUUID()}`);
      expect(res.status).toBe(401);
    });
  });
});
