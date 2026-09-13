import { sql } from "drizzle-orm";
import { check, date, index, pgTable, time, timestamp, uuid } from "drizzle-orm/pg-core";
import { availabilityExceptionKindEnum, consultationTypeEnum } from "./enums";
import { practiceLocation } from "./practice-location";
import { practitionerProfile } from "./practitioner-profile";

export const availabilityException = pgTable(
  "availability_exception",
  {
    id: uuid("id").primaryKey(),
    practitionerProfileId: uuid("practitioner_profile_id")
      .notNull()
      .references(() => practitionerProfile.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    kind: availabilityExceptionKindEnum("kind").notNull(),
    startTime: time("start_time"),
    endTime: time("end_time"),
    consultationTypes: consultationTypeEnum("consultation_types").array(),
    locationId: uuid("location_id").references(() => practiceLocation.id),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("availability_exception_profile_date_active_idx")
      .on(table.practitionerProfileId, table.date)
      .where(sql`${table.deletedAt} is null`),
    check(
      "availability_exception_time_order",
      sql`${table.endTime} is null or ${table.startTime} is null or ${table.endTime} > ${table.startTime}`,
    ),
    check(
      "availability_exception_extra_has_times",
      sql`${table.kind} <> 'extra' or (${table.startTime} is not null and ${table.endTime} is not null)`,
    ),
  ],
);
