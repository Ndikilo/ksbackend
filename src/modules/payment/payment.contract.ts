import { z } from "@hono/zod-openapi";

import { PAYMENT_PROVIDERS, PAYMENT_STATUSES } from "@/domain/payment/payment";

/** Checkout request: which booking, on which rail, debiting which wallet. */
export const CreatePaymentBody = z
  .object({
    appointmentId: z.uuid().openapi({
      description:
        "The PENDING appointment being paid for (the caller must be its booking patient).",
      example: "0b9e6b1e-6f1a-4d3e-9d2a-6f1a4d3e9d2a",
    }),
    provider: z.enum(PAYMENT_PROVIDERS).openapi({
      description: "The mobile-money rail to charge.",
      example: "momo",
    }),
    payerPhone: z.string().min(8).max(20).openapi({
      description:
        "The wallet to debit — local (6XXXXXXXX) or E.164 (+2376XXXXXXXX) MSISDN. The charge amount is the appointment's price snapshot.",
      example: "+237690000000",
    }),
  })
  .openapi("CreatePayment");

export const PaymentStatusSchema = z.enum(PAYMENT_STATUSES).openapi({
  description:
    "Charge lifecycle: initiated → pending → succeeded | failed, succeeded → refunded. An appointment confirms only when its charge succeeds.",
  example: "pending",
});

export const PaymentResponse = z
  .object({
    id: z
      .uuid()
      .openapi({ description: "The payment id (also the provider's idempotency reference)." }),
    appointmentId: z.uuid().openapi({ description: "The charged appointment." }),
    provider: z.enum(PAYMENT_PROVIDERS).openapi({ description: "The rail the charge runs on." }),
    status: PaymentStatusSchema,
    amountXaf: z.number().int().positive().openapi({
      description: "Charge amount in XAF (integer, no floats) — the booking's price snapshot.",
      example: 5000,
    }),
    providerChargeId: z.string().nullable().openapi({
      description: "The provider's handle for this charge (set once the provider accepted it).",
    }),
    failureReason: z.string().nullable().openapi({
      description: "Why the charge failed; set iff status is `failed`.",
    }),
    refundedAt: z.string().nullable().openapi({
      description: "When the charge was refunded; set iff status is `refunded`.",
    }),
    createdAt: z.string().openapi({ description: "ISO-8601 creation time." }),
  })
  .openapi("Payment");

export const PaymentIdParam = z.object({
  id: z.uuid().openapi({
    description: "The payment id (from a checkout response).",
    example: "0b9e6b1e-6f1a-4d3e-9d2a-6f1a4d3e9d2a",
  }),
});

export const RefundBody = z
  .object({
    reason: z.string().min(3).max(500).openapi({
      description:
        "Why the charge is being refunded — stored on the payment for audit. The refund also CANCELS the booking and frees its slot, atomically.",
      example: "Practitioner cancelled the session.",
    }),
  })
  .openapi("Refund");
