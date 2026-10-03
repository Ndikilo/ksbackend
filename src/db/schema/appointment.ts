import { sql } from "drizzle-orm";
import {
  boolean,
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
import { availabilitySlot } from "./availability-slot";
import { consultationOffering } from "./consultation-offering";
import { dependent } from "./dependent";
import { appointmentStatusEnum, consultationTypeEnum } from "./enums";
import { practitionerProfile } from "./practitioner-profile";

// A booking: an account holder (patient) reserves one published availability
// slot of a practitioner, for themselves (`dependentId is null`) or a managed
// dependent. Commercial terms (type/duration/price) and the cancellation policy
// in force are SNAPSHOT-ED onto the row at booking time so history survives
// later offering edits, slot cancellation, and practitioner price changes.
//
// Status machine: pending → confirmed → cancelled | completed | no_show
// (cancel is legal from pending or confirmed only; service layer enforces).
//
// Double-booking guard: the partial unique index below admits AT MOST ONE
// active (pending/confirmed) appointment per slot — cancelling frees the slot
// for rebooking. The booking service additionally locks the slot row in a
// transaction (P3.T2); this index is the database-level backstop.
export const appointment = pgTable(
  "appointment",
  {
    id: uuid("id").primaryKey(),
    patientUserId: text("patient_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // null = booked for the patient themself; set null (not cascade) so the
    // appointment record survives a hard dependent delete (history).
    dependentId: uuid("dependent_id").references(() => dependent.id, { onDelete: "set null" }),
    practitionerProfileId: uuid("practitioner_profile_id")
      .notNull()
      .references(() => practitionerProfile.id, { onDelete: "cascade" }),
    slotId: uuid("slot_id")
      .notNull()
      .references(() => availabilitySlot.id, { onDelete: "cascade" }),
    consultationOfferingId: uuid("consultation_offering_id")
      .notNull()
      .references(() => consultationOffering.id),
    status: appointmentStatusEnum("status").notNull().default("pending"),
    // Snapshots (from the slot + offering at booking time).
    consultationType: consultationTypeEnum("consultation_type").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    priceXaf: integer("price_xaf").notNull(),
    // Cancellation policy in force when the booking was made (the
    // practitioner-configurable values live on the practitioner side — P3.T5;
    // these snapshots keep old bookings judging by the rules they accepted).
    cancellationNoticeHours: integer("cancellation_notice_hours").notNull(),
    cancellationFeeXaf: integer("cancellation_fee_xaf").notNull().default(0),
    lateCancellation: boolean("late_cancellation").notNull().default(false),
    // Cancellation bookkeeping (set iff status = 'cancelled' — check below).
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledByUserId: text("cancelled_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // FK columns are join/delete hot paths (reverse lookups + ON DELETE scans)
    // — Postgres does not index the referencing side automatically (P0.T7).
    // List reads filter+sort by owner and time, so the practitioner/patient
    // indexes lead with the FK and carry starts_at for range scans.
    index("appointment_patient_user_starts_idx").on(t.patientUserId, t.startsAt),
    index("appointment_practitioner_starts_idx").on(t.practitionerProfileId, t.startsAt),
    index("appointment_dependent_id_idx").on(t.dependentId),
    index("appointment_slot_id_idx").on(t.slotId),
    index("appointment_consultation_offering_id_idx").on(t.consultationOfferingId),
    index("appointment_cancelled_by_user_id_idx").on(t.cancelledByUserId),
    // Concurrency backstop: one ACTIVE appointment per slot (see table comment).
    uniqueIndex("appointment_slot_active_unique")
      .on(t.slotId)
      .where(sql`${t.status} in ('pending', 'confirmed')`),
    check("appointment_time_order", sql`${t.endsAt} > ${t.startsAt}`),
    check("appointment_price_nonnegative", sql`${t.priceXaf} >= 0`),
    check("appointment_notice_nonnegative", sql`${t.cancellationNoticeHours} >= 0`),
    check("appointment_fee_nonnegative", sql`${t.cancellationFeeXaf} >= 0`),
    // cancelled ⟺ cancelledAt: the timestamp is the audit anchor of the cancel.
    check(
      "appointment_cancelled_has_timestamp",
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`,
    ),
  ],
);
