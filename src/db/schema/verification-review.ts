import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { verificationDecisionEnum } from "./enums";
import { practitionerProfile } from "./practitioner-profile";

// Append-only audit trail of admin verification decisions ("who approved this
// doctor, when, and why-if-rejected").
export const verificationReview = pgTable(
  "verification_review",
  {
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
  },
  // Per-profile history reads, reviewer activity audits, and the cascade scan
  // on practitioner deletion all key off these FK columns.
  (t) => [
    index("verification_review_practitioner_profile_id_idx").on(t.practitionerProfileId),
    index("verification_review_reviewer_user_id_idx").on(t.reviewerUserId),
  ],
);
