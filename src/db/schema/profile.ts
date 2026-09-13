import { date, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { sexEnum } from "./enums";

// The base profile, 1:1 with the better-auth `user`. Common identity/contact/
// consent for EVERY role; role-specific data lives in the extension tables
// (patient_profile, practitioner_profile, admin_profile). Cascades on user delete.
export const profile = pgTable("profile", {
  id: uuid("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  surname: text("surname").notNull(),
  givenNames: text("given_names").notNull(),
  phone: text("phone"),
  dateOfBirth: date("date_of_birth"),
  sex: sexEnum("sex"),
  avatarFileKey: text("avatar_file_key"),
  consentAcceptedAt: timestamp("consent_accepted_at", { withTimezone: true }).notNull(),
  consentVersion: text("consent_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
