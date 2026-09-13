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
