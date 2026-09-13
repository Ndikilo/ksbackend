import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";

// The patient extension of the base `profile`. Common identity/contact/consent
// live on `profile`; this table marks a user as a patient and holds patient-only
// data (emergency contact). Cascades on user delete.
export const patientProfile = pgTable("patient_profile", {
  id: uuid("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  emergencyContactName: text("emergency_contact_name"),
  emergencyContactPhone: text("emergency_contact_phone"),
  emergencyContactRelationship: text("emergency_contact_relationship"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
