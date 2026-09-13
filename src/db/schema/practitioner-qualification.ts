import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { practitionerProfile } from "./practitioner-profile";
import { qualificationKindEnum } from "./enums";

export const practitionerQualification = pgTable(
  "practitioner_qualification",
  {
    id: uuid("id").primaryKey(),
    practitionerProfileId: uuid("practitioner_profile_id")
      .notNull()
      .references(() => practitionerProfile.id, { onDelete: "cascade" }),
    kind: qualificationKindEnum("kind").notNull(),
    title: text("title").notNull(),
    institution: text("institution").notNull(),
    country: text("country").notNull(),
    year: integer("year").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("practitioner_qualification_profile_active_idx")
      .on(table.practitionerProfileId, table.sortOrder)
      .where(sql`${table.deletedAt} is null`),
    check("practitioner_qualification_year_range", sql`${table.year} between 1900 and 2200`),
  ],
);
