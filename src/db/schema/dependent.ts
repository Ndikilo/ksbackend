import { date, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sexEnum } from "./enums";

// A dependent PERSON (no login) that account holders book care for. Ownership +
// the per-caregiver relationship live on `caregiver_link` (M:N) — a dependent can
// have several caregivers. Soft-deleted so history survives.
export const dependent = pgTable("dependent", {
  id: uuid("id").primaryKey(),
  surname: text("surname").notNull(),
  givenNames: text("given_names").notNull(),
  dateOfBirth: date("date_of_birth").notNull(),
  sex: sexEnum("sex").notNull(),
  phone: text("phone"),
  location: text("location"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
