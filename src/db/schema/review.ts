import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { practitionerProfile } from "./practitioner-profile";

// A patient's rating (1–5) + optional comment for a verified practitioner. Distinct
// from `verification_review` (the admin credential-decision audit). Soft-deletable;
// the practitioner's denormalized rating aggregate is recomputed from the active rows.
export const review = pgTable(
  "review",
  {
    id: uuid("id").primaryKey(),
    practitionerProfileId: uuid("practitioner_profile_id")
      .notNull()
      .references(() => practitionerProfile.id, { onDelete: "cascade" }),
    reviewerUserId: text("reviewer_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(),
    comment: text("comment"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One ACTIVE review per (reviewer, practitioner) — drives create-vs-update.
    uniqueIndex("review_one_active_per_pair")
      .on(t.reviewerUserId, t.practitionerProfileId)
      .where(sql`${t.deletedAt} is null`),
    // Powers the AVG/COUNT recompute and a practitioner's review list.
    index("review_practitioner_active_idx")
      .on(t.practitionerProfileId)
      .where(sql`${t.deletedAt} is null`),
    check("review_rating_range", sql`${t.rating} between 1 and 5`),
  ],
);
