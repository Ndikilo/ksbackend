import { describe, expect, it } from "vitest";

import {
  signWebhookPayload,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
} from "./webhook-signature";

/**
 * P5.T3 — webhook HMAC fail-closed verification. Pure string functions: every
 * branch that must reject is driven here (no DB, no HTTP).
 */
describe("webhook signature (P5.T3)", () => {
  const secret = "test-webhook-secret";
  const body = JSON.stringify({ provider: "momo", providerChargeId: "c1", status: "succeeded" });

  it("a correctly signed payload verifies; the constant names the transport header", () => {
    expect(verifyWebhookSignature(secret, body, signWebhookPayload(secret, body))).toBe(true);
    expect(WEBHOOK_SIGNATURE_HEADER).toBe("x-kanasante-signature");
  });

  it("a tampered body does not verify (the signature covers the exact bytes)", () => {
    const signature = signWebhookPayload(secret, body);
    const tampered = body.replace("succeeded", "failed");
    expect(verifyWebhookSignature(secret, tampered, signature)).toBe(false);
  });

  it("the wrong secret does not verify", () => {
    expect(verifyWebhookSignature(secret, body, signWebhookPayload("other-secret", body))).toBe(
      false,
    );
  });

  it("a missing or malformed header does not verify", () => {
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(secret, body, "")).toBe(false);
    expect(verifyWebhookSignature(secret, body, body)).toBe(false); // no sha256= prefix
    expect(verifyWebhookSignature(secret, body, "md5=deadbeef")).toBe(false);
    expect(verifyWebhookSignature(secret, body, "sha256=not-even-hex")).toBe(false);
  });

  it("an UNCONFIGURED secret rejects EVERY delivery (never open-by-default)", () => {
    expect(verifyWebhookSignature("", body, signWebhookPayload("", body))).toBe(false);
    expect(verifyWebhookSignature("   ", body, signWebhookPayload("", body))).toBe(false);
  });

  it("signatures are deterministic and hex-encoded", () => {
    const first = signWebhookPayload(secret, body);
    const second = signWebhookPayload(secret, body);
    expect(first).toBe(second);
    expect(first.startsWith("sha256=")).toBe(true);
    expect(first.slice("sha256=".length)).toMatch(/^[0-9a-f]{64}$/);
  });
});
