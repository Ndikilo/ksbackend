import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Handlebars from "handlebars";
import { type Locale, translate } from "./i18n";

// Templates (HTML structure) live as .hbs files; the localized COPY lives in the
// locale files (single source, CI-checked). We compile once at module load.
const templatesDir = join(dirname(fileURLToPath(import.meta.url)), "email-templates");
const load = (name: string) => Handlebars.compile(readFileSync(join(templatesDir, name), "utf8"));

const layout = load("layout.hbs");
const codeTemplate = load("code.hbs");
const noticeTemplate = load("notice.hbs");
const receiptTemplate = load("receipt.hbs");

/**
 * The data a receipt email is rendered FROM — mapped off the payment record
 * (P5.T4). `paidAt` is the receipt issue time; the reference is the payment id
 * the mobile-money statement shows.
 */
export type ReceiptEmailData = {
  readonly receiptNumber: string;
  readonly amountXaf: number;
  readonly provider: "momo" | "orange_money";
  readonly paidAt: Date;
  readonly reference: string;
};

/** Brand names — the same in every locale. */
const PROVIDER_LABEL = {
  momo: "MoMo",
  orange_money: "Orange Money",
} satisfies Record<ReceiptEmailData["provider"], string>;

/** Clinic-local receipt timestamps: the consultation happens in Cameroon. */
const RECEIPT_TIME_ZONE = "Africa/Douala";

const formatPaidAt = (locale: Locale, at: Date): string =>
  new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: RECEIPT_TIME_ZONE,
  }).format(at);

export type EmailScenario =
  | { readonly kind: "otp"; readonly otp: string }
  | { readonly kind: "reset-password"; readonly otp: string }
  | { readonly kind: "verification-approved" }
  | { readonly kind: "verification-rejected"; readonly reason: string }
  | { readonly kind: "caregiver-invitation"; readonly token: string }
  | { readonly kind: "receipt"; readonly receipt: ReceiptEmailData };

export type RenderedEmail = { readonly subject: string; readonly html: string };

/** Render a localized, layout-wrapped HTML email for a given scenario. */
export const renderEmail = (scenario: EmailScenario, locale: Locale): RenderedEmail => {
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);
  const wrap = (subject: string, body: string): RenderedEmail => ({
    subject,
    html: layout({ title: subject, body, footer: t("emails.common.footer") }),
  });

  switch (scenario.kind) {
    case "otp":
    case "reset-password": {
      const ns = scenario.kind === "otp" ? "emails.otp" : "emails.resetPassword";
      const body = codeTemplate({
        heading: t(`${ns}.heading`),
        intro: t(`${ns}.body`),
        code: scenario.otp,
        expiry: t("emails.common.expiry"),
      });
      return wrap(t(`${ns}.subject`), body);
    }
    case "verification-approved": {
      const body = noticeTemplate({
        heading: t("emails.verificationApproved.heading"),
        message: t("emails.verificationApproved.body"),
      });
      return wrap(t("emails.verificationApproved.subject"), body);
    }
    case "verification-rejected": {
      const body = noticeTemplate({
        heading: t("emails.verificationRejected.heading"),
        message: t("emails.verificationRejected.body", { reason: scenario.reason }),
      });
      return wrap(t("emails.verificationRejected.subject"), body);
    }
    case "caregiver-invitation": {
      const body = noticeTemplate({
        heading: t("emails.caregiverInvitation.heading"),
        message: t("emails.caregiverInvitation.body", { token: scenario.token }),
      });
      return wrap(t("emails.caregiverInvitation.subject"), body);
    }
    case "receipt": {
      const { receipt } = scenario;
      const body = receiptTemplate({
        heading: t("emails.receipt.heading"),
        intro: t("emails.receipt.intro"),
        rows: [
          { label: t("emails.receipt.receiptNumber"), value: receipt.receiptNumber },
          // Integer XAF, no floats (P5.T6) — the grouping-free canonical form.
          { label: t("emails.receipt.amount"), value: `${receipt.amountXaf} XAF` },
          { label: t("emails.receipt.provider"), value: PROVIDER_LABEL[receipt.provider] },
          { label: t("emails.receipt.paidAt"), value: formatPaidAt(locale, receipt.paidAt) },
          { label: t("emails.receipt.reference"), value: receipt.reference },
        ],
        closing: t("emails.receipt.closing"),
      });
      return wrap(t("emails.receipt.subject", { receiptNumber: receipt.receiptNumber }), body);
    }
  }
};
