import { pgEnum } from "drizzle-orm/pg-core";

export const sexEnum = pgEnum("sex", ["male", "female"]);

export const verificationStatusEnum = pgEnum("verification_status", [
  "incomplete",
  "pending_verification",
  "verified",
  "rejected",
]);

export const verificationDecisionEnum = pgEnum("verification_decision", ["approved", "rejected"]);

export const relationshipEnum = pgEnum("relationship", [
  "child",
  "parent",
  "spouse",
  "sibling",
  "other",
]);

export const notificationCategoryEnum = pgEnum("notification_category", [
  "appointments",
  "verification",
  "security",
  "account",
]);

export const adminScopeEnum = pgEnum("admin_scope", ["super_admin", "verification_reviewer"]);

export const caregiverLinkStatusEnum = pgEnum("caregiver_link_status", [
  "pending",
  "active",
  "revoked",
  "declined",
]);

export const consentEventEnum = pgEnum("consent_event", [
  "invited",
  "accepted",
  "declined",
  "revoked",
  "upgraded",
]);

export const availabilitySlotStatusEnum = pgEnum("availability_slot_status", [
  "open",
  "booked",
  "cancelled",
]);

export const consultationTypeEnum = pgEnum("consultation_type", [
  "in_person",
  "video",
  "home_visit",
]);

export const qualificationKindEnum = pgEnum("qualification_kind", [
  "degree",
  "specialisation",
  "certification",
  "training",
  "award",
]);

export const payoutMethodKindEnum = pgEnum("payout_method_kind", [
  "mtn_momo",
  "orange_money",
  "bank",
]);

export const availabilityExceptionKindEnum = pgEnum("availability_exception_kind", [
  "blocked",
  "extra",
]);

// Appointment status machine: pending → confirmed → cancelled | completed |
// no_show. `cancelled` is reachable from pending or confirmed only (booking
// service enforces the transitions; the DB pins the value set).
export const appointmentStatusEnum = pgEnum("appointment_status", [
  "pending",
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
]);

/** Payment lifecycle (P5.T2): initiated → pending → succeeded/failed; a
 *  succeeded charge can be refunded. `pending` = the provider acknowledged the
 *  charge and we await the wallet confirmation. */
export const paymentStatusEnum = pgEnum("payment_status", [
  "initiated",
  "pending",
  "succeeded",
  "failed",
  "refunded",
]);

/** Mobile-money rails (P5.T1 adapters). */
export const paymentProviderEnum = pgEnum("payment_provider", ["momo", "orange_money"]);

/** Delivery channels for the notification outbox (P6.T1). */
export const notificationChannelEnum = pgEnum("notification_channel", ["email", "push", "sms"]);

/** Outbox delivery lifecycle (P6.T1): pending → sending → sent; a failed
 *  attempt stays eligible after backoff until the retry budget runs out. */
export const outboxStatusEnum = pgEnum("outbox_status", [
  "pending",
  "sending",
  "sent",
  "failed",
  "dead",
]);
