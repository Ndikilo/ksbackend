import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";

import { WebhookSignatureInvalid } from "@/domain/payment/errors";
import type { Payment } from "@/domain/payment/payment";
import { ValidationFailed } from "@/domain/shared/errors";
import { requireRole } from "@/infra/authz";
import { CurrentUser } from "@/infra/auth";
import { WEBHOOK_SIGNATURE_HEADER } from "@/infra/payments/webhook-signature";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { ErrorResponse } from "@/http/schemas";
import { CreatePaymentBody, PaymentIdParam, PaymentResponse, RefundBody } from "./payment.contract";
import { PaymentService, WebhookEventSchema } from "./payment.service";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });

const toResponse = (p: Payment) => ({
  id: p.id,
  appointmentId: p.appointmentId,
  provider: p.provider,
  status: p.status,
  amountXaf: p.amountXaf,
  providerChargeId: p.providerChargeId,
  failureReason: p.failureReason,
  refundedAt: p.refundedAt === null ? null : p.refundedAt.toISOString(),
  createdAt: p.createdAt.toISOString(),
});

const checkout = createRoute({
  method: "post",
  path: "/v1/payments",
  tags: ["Payments"],
  summary: "Start paying for an appointment (checkout)",
  description: [
    "Create the mobile-money charge for a PENDING appointment (the caller must be its booking",
    "patient; the amount is the booking's price snapshot). Idempotent: if a charge for this",
    "appointment is still open (`initiated`/`pending`) it is returned unchanged — the provider",
    "side is idempotent on the payment id, so client retries can never double-charge. A",
    "`failed` charge may be re-attempted (same or different rail). An already `succeeded`",
    "charge is `409 PAYMENT_STATE_INVALID`.",
    "",
    "When the rail's credentials are unconfigured (merchant onboarding is a deploy-time action)",
    "the call fails with `503 PAYMENT_PROVIDER_UNAVAILABLE` and the charge stays `initiated` —",
    "retry once credentials exist. A wallet refusal is `402 PAYMENT_DECLINED`.",
    "",
    "The appointment CONFIRMS only when this charge succeeds (webhook or polling), never before.",
  ].join("\n"),
  request: { body: jsonBody(CreatePaymentBody) },
  responses: {
    201: {
      ...jsonBody(PaymentResponse),
      description: "The charge (status `initiated`, or `pending` once the provider accepted it).",
    },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    402: {
      ...jsonBody(ErrorResponse),
      description: "`PAYMENT_DECLINED` — the wallet/provider refused the charge.",
    },
    404: {
      ...jsonBody(ErrorResponse),
      description: "No such appointment, or the caller is not its booking patient.",
    },
    409: {
      ...jsonBody(ErrorResponse),
      description:
        "`APPOINTMENT_STATE_INVALID` (not pending) or `PAYMENT_STATE_INVALID` (already paid).",
    },
    422: {
      ...jsonBody(ErrorResponse),
      description: "Field validation (or a booking with no amount to charge).",
    },
    503: {
      ...jsonBody(ErrorResponse),
      description:
        "`PAYMENT_PROVIDER_UNAVAILABLE` — provider unreachable/misconfigured; retry later.",
    },
  },
});

const getPayment = createRoute({
  method: "get",
  path: "/v1/payments/{id}",
  tags: ["Payments"],
  summary: "Poll a payment's status",
  description: [
    "Read one charge (the payer only — anyone else gets the same `404` as an unknown id).",
    "While the outcome is undecided the provider is POLLED and a decided outcome is applied",
    "through the same atomic funnel as the webhook (a succeeded charge confirms the booking),",
    "so clients can drive the flow by polling alone. Provider trouble never fails the read —",
    "the last known row state is returned instead.",
  ].join("\n"),
  request: { params: PaymentIdParam },
  responses: {
    200: { ...jsonBody(PaymentResponse), description: "The charge in its current state." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    404: {
      ...jsonBody(ErrorResponse),
      description: "No such payment, or the caller is not its payer.",
    },
  },
});

const refund = createRoute({
  method: "post",
  path: "/v1/payments/{id}/refund",
  tags: ["Payments"],
  summary: "Refund a succeeded payment (admin)",
  description: [
    "Flip a `succeeded` charge to `refunded` (audit reason required) and — in the SAME",
    "transaction — cancel the booking and free its slot for rebooking. Atomic: the charge and",
    "the booking flip together or not at all. Anything but a `succeeded` charge is `409",
    "PAYMENT_STATE_INVALID`; a second refund attempt hits the same 409 (the first flipped the",
    "row). Requires the admin role (`403`). Provider-side money movement follows the merchant",
    "rails once live credentials exist; this endpoint is the platform's source of truth.",
  ].join("\n"),
  request: { params: PaymentIdParam, body: jsonBody(RefundBody) },
  responses: {
    200: { ...jsonBody(PaymentResponse), description: "The refunded charge (status `refunded`)." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: { ...jsonBody(ErrorResponse), description: "Requires the admin role." },
    404: { ...jsonBody(ErrorResponse), description: "No such payment." },
    409: {
      ...jsonBody(ErrorResponse),
      description: "`PAYMENT_STATE_INVALID` — only a succeeded charge can be refunded.",
    },
    422: { ...jsonBody(ErrorResponse), description: "Missing or too-short refund reason." },
  },
});

const webhook = createRoute({
  method: "post",
  path: "/v1/payments/webhook",
  tags: ["Payments"],
  summary: "Provider payment webhook (signature-verified)",
  description: [
    "Payment lifecycle callbacks. UNAUTHENTICATED but fail-closed: the caller must sign the RAW",
    "request body with HMAC-SHA256 (shared `PAYMENT_WEBHOOK_SECRET`) and send it in",
    "`X-Kanasante-Signature: sha256=<hex>`. A missing, malformed, or non-matching signature is",
    "`401 WEBHOOK_SIGNATURE_INVALID` and the payload is never processed; with the secret",
    "unconfigured EVERY delivery is rejected.",
    "",
    "Body (platform-canonical form; provider-specific callbacks are adapted to it):",
    '`{ provider: "momo"|"orange_money", providerChargeId: string, status: "succeeded"|"failed",',
    "providerReference?: string, failureReason?: string }`. A `succeeded` event CONFIRMS the",
    "appointment in the same transaction; a duplicate delivery is idempotent (one transition,",
    "the row's current state is returned). Unknown `providerChargeId` is `404` — retry later.",
  ].join("\n"),
  responses: {
    200: {
      ...jsonBody(PaymentResponse),
      description: "The charge after applying the event (unchanged on a duplicate delivery).",
    },
    401: {
      ...jsonBody(ErrorResponse),
      description: "`WEBHOOK_SIGNATURE_INVALID` — missing/malformed/mismatching signature.",
    },
    404: {
      ...jsonBody(ErrorResponse),
      description: "No charge for that provider reference (yet).",
    },
    422: { ...jsonBody(ErrorResponse), description: "Malformed JSON or unexpected payload shape." },
  },
});

export const registerPaymentRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { run, runAuth } = makeRun(runtime);

  app.openapi(checkout, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* PaymentService;
        const charged = yield* service.initiate(user.id, c.req.valid("json"));
        return c.json(toResponse(charged), 201);
      }),
    ),
  );

  app.openapi(getPayment, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* PaymentService;
        const charge = yield* service.get(user.id, c.req.valid("param").id);
        return c.json(toResponse(charge), 200);
      }),
    ),
  );

  app.openapi(refund, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        yield* requireRole("admin");
        const user = yield* CurrentUser;
        const service = yield* PaymentService;
        const refunded = yield* service.refund(
          user.id,
          c.req.valid("param").id,
          c.req.valid("json").reason,
        );
        return c.json(toResponse(refunded), 200);
      }),
    ),
  );

  app.openapi(webhook, (c) =>
    run(
      Effect.gen(function* () {
        const service = yield* PaymentService;
        // Signature FIRST, over the exact raw bytes — the body is not parsed
        // (and nothing about it trusted) before the HMAC matches.
        const raw = yield* Effect.tryPromise({
          try: () => c.req.text(),
          catch: () => new WebhookSignatureInvalid({}),
        });
        const valid = yield* service.verifyWebhook(raw, c.req.header(WEBHOOK_SIGNATURE_HEADER));
        if (!valid) {
          return yield* Effect.fail(new WebhookSignatureInvalid({}));
        }
        // SAFETY: JSON.parse returns `any` by definition — the binding is
        // immediately widened to `unknown` and never trusted until the zod
        // schema below has parsed it.
        const decoded: unknown = yield* Effect.try({
          try: () => JSON.parse(raw),
          catch: () =>
            new ValidationFailed({ issues: [{ path: "body", message: "Malformed JSON." }] }),
        });
        const parsed = WebhookEventSchema.safeParse(decoded);
        if (!parsed.success) {
          return yield* Effect.fail(
            new ValidationFailed({
              issues: parsed.error.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
              })),
            }),
          );
        }
        const charge = yield* service.applyProviderEvent({
          provider: parsed.data.provider,
          providerChargeId: parsed.data.providerChargeId,
          status: parsed.data.status,
          providerReference: parsed.data.providerReference,
          failureReason: parsed.data.failureReason,
        });
        return c.json(toResponse(charge), 200);
      }),
    ),
  );
};
