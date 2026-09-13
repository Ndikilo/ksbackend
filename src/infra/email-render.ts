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

export type EmailScenario =
  | { readonly kind: "otp"; readonly otp: string }
  | { readonly kind: "reset-password"; readonly otp: string }
  | { readonly kind: "verification-approved" }
  | { readonly kind: "verification-rejected"; readonly reason: string }
  | { readonly kind: "caregiver-invitation"; readonly token: string };

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
  }
};
