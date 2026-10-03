import { describe, expect, it } from "vitest";

import { renderEmail, type ReceiptEmailData } from "./email-render";

/**
 * P5.T4 — the receipt email is rendered FROM the payment record's receipt
 * fields (receiptNumber/amount/provider/issuedAt + the payment id as the
 * statement reference), localized en/fr, wrapped in the shared layout.
 */

/** 2026-10-03T12:00:00Z — built from the epoch so the value stays fixed. */
const PAID_AT: Date = (() => {
  const at = new Date(0);
  at.setUTCFullYear(2026, 9, 3);
  at.setUTCHours(12, 0, 0, 0);
  return at;
})();

const receipt: ReceiptEmailData = {
  receiptNumber: "KS-9a1b2c3d-0000-4000-8000-000000000001",
  amountXaf: 5000,
  provider: "momo",
  paidAt: PAID_AT, // 13:00 in Africa/Douala
  reference: "9a1b2c3d-0000-4000-8000-000000000001",
};

/** The Douala-local rendering the template must show (same formatter, same TZ). */
const expectedPaidAt = (locale: "en" | "fr"): string =>
  new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Douala",
  }).format(receipt.paidAt);

describe("renderEmail (receipt)", () => {
  it("renders the English receipt from the payment record", () => {
    const email = renderEmail({ kind: "receipt", receipt }, "en");
    expect(email.subject).toBe(`Your KanaSanté receipt ${receipt.receiptNumber}`);
    // Receipt facts, not prose: number, integer-XAF amount, rail label,
    // Douala-local timestamp, statement reference.
    expect(email.html).toContain(receipt.receiptNumber);
    expect(email.html).toContain("5000 XAF");
    expect(email.html).toContain("MoMo");
    expect(email.html).toContain(expectedPaidAt("en"));
    expect(email.html).toContain("Amount paid");
    // Wrapped in the shared layout (footer interpolated).
    expect(email.html).toContain("KanaSanté — connecting you to trusted care.");
  });

  it("renders the French receipt (localized copy + fr date)", () => {
    const email = renderEmail({ kind: "receipt", receipt }, "fr");
    expect(email.subject).toBe(`Votre reçu KanaSanté ${receipt.receiptNumber}`);
    expect(email.html).toContain("N° de reçu");
    expect(email.html).toContain("Montant payé");
    expect(email.html).toContain("Moyen de paiement");
    expect(email.html).toContain(expectedPaidAt("fr"));
    expect(email.html).not.toContain("Amount paid");
  });

  it("labels the Orange Money rail (brand names are locale-invariant)", () => {
    const email = renderEmail(
      { kind: "receipt", receipt: { ...receipt, provider: "orange_money" } },
      "fr",
    );
    expect(email.html).toContain("Orange Money");
  });

  it("the locales genuinely diverge (a missing translation cannot pass silently)", () => {
    const en = renderEmail({ kind: "receipt", receipt }, "en");
    const fr = renderEmail({ kind: "receipt", receipt }, "fr");
    expect(en.html).not.toBe(fr.html);
    expect(en.subject).not.toBe(fr.subject);
  });
});
