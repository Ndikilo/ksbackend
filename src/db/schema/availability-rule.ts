import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  time,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { consultationTypeEnum } from "./enums";
import { practiceLocation } from "./practice-location";
import { practitionerProfile } from "./practitioner-profile";

export const availabilityRule = pgTable(
  "availability_rule",
  {
    id: uuid("id").primaryKey(),
    practitionerProfileId: uuid("practitioner_profile_id")
      .notNull()
      .references(() => practitionerProfile.id, { onDelete: "cascade" }),
    weekday: integer("weekday").notNull(),
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    slotDurationMin: integer("slot_duration_min").notNull(),
    consultationTypes: consultationTypeEnum("consultation_types").array().notNull(),
    locationId: uuid("location_id").references(() => practiceLocation.id),
    timezone: text("timezone").notNull().default("Africa/Douala"),
    validFrom: date("valid_from"),
    validTo: date("valid_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("availability_rule_profile_weekday_idx").on(table.practitionerProfileId, table.weekday),
    check("availability_rule_weekday_range", sql`${table.weekday} between 0 and 6`),
    check("availability_rule_time_order", sql`${table.endTime} <> ${table.startTime}`),
    check("availability_rule_duration_range", sql`${table.slotDurationMin} between 5 and 240`),
    check(
      "availability_rule_validity_order",
      sql`${table.validTo} is null or ${table.validFrom} is null or ${table.validTo} >= ${table.validFrom}`,
    ),
  ],
);
