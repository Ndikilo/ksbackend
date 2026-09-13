import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { consultationTypeEnum } from "./enums";
import { practitionerProfile } from "./practitioner-profile";

export const consultationOffering = pgTable(
  "consultation_offering",
  {
    id: uuid("id").primaryKey(),
    practitionerProfileId: uuid("practitioner_profile_id")
      .notNull()
      .references(() => practitionerProfile.id, { onDelete: "cascade" }),
    consultationType: consultationTypeEnum("consultation_type").notNull(),
    durationMin: integer("duration_min").notNull(),
    priceXaf: integer("price_xaf").notNull(),
    active: boolean("active").notNull().default(true),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("consultation_offering_profile_type_duration_unique")
      .on(table.practitionerProfileId, table.consultationType, table.durationMin)
      .where(sql`${table.deletedAt} is null`),
    check("consultation_offering_duration_range", sql`${table.durationMin} between 5 and 240`),
    check("consultation_offering_price_nonnegative", sql`${table.priceXaf} >= 0`),
  ],
);
