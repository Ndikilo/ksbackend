import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { dependent } from "./dependent";
import { caregiverLinkStatusEnum, relationshipEnum } from "./enums";

// The M:N consent edge between a caregiver (user) and a care subject. The subject
// is EITHER a managed dependent (no login) OR another user account (a linked
// dependent). Managed links are `active` immediately; account links start
// `pending` until the invitee accepts. Cascades on either side's delete.
export const caregiverLink = pgTable("caregiver_link", {
  id: uuid("id").primaryKey(),
  caregiverUserId: text("caregiver_user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  // Exactly one of the two subjects is set (enforced in the service layer).
  managedDependentId: uuid("managed_dependent_id").references(() => dependent.id, {
    onDelete: "cascade",
  }),
  subjectUserId: text("subject_user_id").references(() => user.id, { onDelete: "cascade" }),
  relationship: relationshipEnum("relationship").notNull(),
  status: caregiverLinkStatusEnum("status").notNull(),
  // Invitation bookkeeping (account/linked dependents only).
  inviteIdentifier: text("invite_identifier"),
  inviteToken: text("invite_token").unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  invitedAt: timestamp("invited_at", { withTimezone: true }),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
