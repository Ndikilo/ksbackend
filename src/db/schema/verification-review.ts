import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { verificationDecisionEnum } from "./enums";
import { practitionerProfile } from "./practitioner-profile";

// Append-only audit trail of admin verification decisions ("who approved this
// doctor, when, and why-if-rejected").
export const verificationReview = pgTable("verification_review", {
  id: uuid("id").primaryKey(),
  practitionerProfileId: uuid("practitioner_profile_id")
    .notNull()
    .references(() => practitionerProfile.id, { onDelete: "cascade" }),
  reviewerUserId: text("reviewer_user_id")
    .notNull()
    .references(() => user.id),
  decision: verificationDecisionEnum("decision").notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
