import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC-SHA256 signature scheme for payment webhooks (P5.T3). The sender signs
 * the RAW request body with a shared secret (`PAYMENT_WEBHOOK_SECRET`) and
 * sends `X-Kanasante-Signature: sha256=<hex>`. Verification is fail-closed:
 * an empty secret (not configured yet), a missing header, a malformed header,
 * or any mismatch — including under a length leak — rejects the payload.
 *
 * Pure functions over strings; the route reads the raw body BEFORE parsing so
 * the signature always covers the exact bytes the provider sent.
 */

export const WEBHOOK_SIGNATURE_HEADER = "x-kanasante-signature";

const SIGNATURE_PREFIX = "sha256=";

/** Sign a raw body — the exact hex form the verification side expects. */
export const signWebhookPayload = (secret: string, rawBody: string): string =>
  SIGNATURE_PREFIX + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

/** True only when `expected` and `actual` are byte-identical without timing leaks. */
const safeEqual = (expected: string, actual: string): boolean => {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Verify a webhook signature. `signatureHeader` is the (possibly absent) raw
 * header value. Anything but an exact `sha256=<hex hmac of rawBody>` fails —
 * including when the secret is unconfigured (empty), which keeps the endpoint
 * unusable-by-default instead of accepting everything.
 */
export const verifyWebhookSignature = (
  secret: string,
  rawBody: string,
  signatureHeader: string | undefined,
): boolean => {
  if (secret.trim() === "" || signatureHeader === undefined) return false;
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) return false;
  const expected = signWebhookPayload(secret, rawBody);
  return safeEqual(expected, signatureHeader);
};
