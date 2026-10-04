import { describe, expect, it } from "vitest";

import { LIFECYCLE_VARIANTS } from "@/domain/appointment/notifications";

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

describe("renderEmail (reminder, P6.T2)", () => {
  // 2026-03-30T09:00Z = 10:00 in Africa/Douala (fixed +1, no DST).
  const WHEN: Date = (() => {
    const at = new Date(0);
    at.setUTCFullYear(2026, 2, 30);
    at.setUTCHours(9, 0, 0, 0);
    return at;
  })();
  const scenario = (horizon: "24h" | "1h") =>
    ({ kind: "reminder", horizon, when: WHEN, practitionerName: "Dr Ngo Bell" }) as const;

  /** The Douala-local rendering the email must carry (clinic clock discipline). */
  const expectedWhen = (locale: "en" | "fr"): string =>
    new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : "en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Africa/Douala",
    }).format(WHEN);

  it("renders the 24h reminder en and fr — clinic-local time, practitioner named", () => {
    const en = renderEmail(scenario("24h"), "en");
    expect(en.subject).toBe(`Reminder — appointment at ${expectedWhen("en")}`);
    expect(en.html).toContain("Dr Ngo Bell");
    expect(en.html).toContain(expectedWhen("en"));
    expect(en.html).toContain("10:00"); // 09:00Z on the Douala wall clock
    expect(en.html).toContain("KanaSanté — connecting you to trusted care.");

    const fr = renderEmail(scenario("24h"), "fr");
    expect(fr.subject).toBe(`Rappel — rendez-vous le ${expectedWhen("fr")}`);
    expect(fr.html).toContain("Nous vous rappelons");
    expect(fr.html).not.toContain("We");
  });

  it("the 1h horizon has its own honest copy (the appointment is imminent)", () => {
    const en = renderEmail(scenario("1h"), "en");
    expect(en.html).toContain("starting soon");
    expect(en.html).not.toContain("tomorrow");

    const fr = renderEmail(scenario("1h"), "fr");
    expect(fr.html).toContain("commence bientôt");
    expect(fr.subject).not.toBe(renderEmail(scenario("24h"), "fr").subject);
  });

  it("no raw template key or unreplaced param can ever ship", () => {
    for (const locale of ["en", "fr"] as const) {
      for (const horizon of ["24h", "1h"] as const) {
        const email = renderEmail(scenario(horizon), locale);
        expect(email.subject).not.toMatch(/emails\.|\{when\}|\{practitioner\}/);
        expect(email.html).not.toMatch(/emails\.|\{when\}|\{practitioner\}/);
      }
    }
  });
});

describe("renderEmail (appointment lifecycle, P6.T3)", () => {
  // 2026-03-30T09:00Z = 10:00 in Africa/Douala (fixed +1, no DST).
  const WHEN: Date = (() => {
    const at = new Date(0);
    at.setUTCFullYear(2026, 2, 30);
    at.setUTCHours(9, 0, 0, 0);
    return at;
  })();

  const expectedWhen = (locale: "en" | "fr"): string =>
    new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : "en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Africa/Douala",
    }).format(WHEN);

  it("renders patient-side copy with the practitioner's name (en + fr)", () => {
    const en = renderEmail(
      { kind: "appointment", variant: "confirmed-patient", when: WHEN, counterpart: "Dr Ngo Bell" },
      "en",
    );
    expect(en.subject).toBe(`Appointment confirmed — ${expectedWhen("en")}`);
    expect(en.html).toContain("Dr Ngo Bell");
    expect(en.html).toContain(expectedWhen("en"));
    expect(en.html).toContain("KanaSanté — connecting you to trusted care.");

    const fr = renderEmail(
      { kind: "appointment", variant: "confirmed-patient", when: WHEN, counterpart: "Dr Ngo Bell" },
      "fr",
    );
    expect(fr.subject).toBe(`Rendez-vous confirmé — ${expectedWhen("fr")}`);
    expect(fr.html).toContain("Dr Ngo Bell");
    expect(fr.html).not.toContain("is confirmed");
  });

  it("renders practitioner-side copy with the PATIENT's name (the domain table decides)", () => {
    const fr = renderEmail(
      {
        kind: "appointment",
        variant: "cancelled-by-patient",
        when: WHEN,
        counterpart: "Ada Ngono",
      },
      "fr",
    );
    expect(fr.subject).toContain("annulé par le patient");
    expect(fr.html).toContain("Ada Ngono");
    expect(fr.html).not.toContain("Dr Ngo Bell");
  });

  it("every variant renders in both locales with no raw keys (the full copy table)", () => {
    for (const locale of ["en", "fr"] as const) {
      for (const variant of LIFECYCLE_VARIANTS) {
        const email = renderEmail(
          { kind: "appointment", variant, when: WHEN, counterpart: "Counterpart Name" },
          locale,
        );
        // A rendered subject that IS the namespace means a missing translation.
        expect(email.subject).not.toMatch(/emails\.|\{when\}|\{patient\}|\{practitioner\}/);
        expect(email.html).not.toMatch(/emails\.|\{when\}|\{patient\}|\{practitioner\}/);
        expect(email.subject.length).toBeGreaterThan(10);
        expect(email.html).toContain("Counterpart Name");
        expect(email.html).toContain(expectedWhen(locale));
      }
    }
  });

  it("the locales genuinely diverge (a missing fr key falls back visibly)", () => {
    const en = renderEmail(
      { kind: "appointment", variant: "declined", when: WHEN, counterpart: "Dr Ngo Bell" },
      "en",
    );
    const fr = renderEmail(
      { kind: "appointment", variant: "declined", when: WHEN, counterpart: "Dr Ngo Bell" },
      "fr",
    );
    expect(en.subject).not.toBe(fr.subject);
    expect(en.html).not.toBe(fr.html);
  });
});
