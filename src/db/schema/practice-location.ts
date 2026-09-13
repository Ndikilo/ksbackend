import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { consultationTypeEnum } from "./enums";
import { practitionerProfile } from "./practitioner-profile";

export const practiceLocation = pgTable(
  "practice_location",
  {
    id: uuid("id").primaryKey(),
    practitionerProfileId: uuid("practitioner_profile_id")
      .notNull()
      .references(() => practitionerProfile.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    addressLine1: text("address_line_1").notNull(),
    addressLine2: text("address_line_2"),
    city: text("city").notNull(),
    region: text("region").notNull(),
    country: text("country").notNull().default("CM"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    consultationTypes: consultationTypeEnum("consultation_types").array().notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("practice_location_profile_active_idx")
      .on(table.practitionerProfileId)
      .where(sql`${table.deletedAt} is null`),
    uniqueIndex("practice_location_one_primary")
      .on(table.practitionerProfileId)
      .where(sql`${table.isPrimary} = true and ${table.deletedAt} is null`),
  ],
);
