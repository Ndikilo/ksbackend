import {
  boolean,
  doublePrecision,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { consultationTypeEnum, verificationStatusEnum } from "./enums";
import { profession } from "./profession";

// The practitioner extension of the base `profile`: profession, verification state,
// and the sensitive identifiers (stored encrypted with a deterministic HMAC for
// dedupe). Common identity/contact/consent live on `profile`. Cascades on user delete.
export const practitionerProfile = pgTable("practitioner_profile", {
  id: uuid("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  professionId: uuid("profession_id")
    .notNull()
    .references(() => profession.id),
  prefix: text("prefix"),
  location: text("location"),
  // Public/bookable profile — shown to patients once verified (no sensitive data).
  specialty: text("specialty"),
  bio: text("bio"),
  languagesSpoken: text("languages_spoken").array(),
  // Temporary migration marker: true when a pre-ISO language value could not be mapped.
  // New writes are reference-validated and always set this false.
  languagesLegacy: boolean("languages_legacy").notNull().default(false),
  yearsExperience: integer("years_experience"),
  consultationFeeXaf: integer("consultation_fee_xaf"),
  consultationTypes: consultationTypeEnum("consultation_types").array(),
  // Denormalized review aggregate — kept in sync (recompute-from-scratch) inside the
  // same transaction as every review write, so search can sort/filter on it cheaply.
  ratingAverage: numeric("rating_average", { precision: 3, scale: 2, mode: "number" })
    .notNull()
    .default(0),
  ratingCount: integer("rating_count").notNull().default(0),
  // Coordinates for distance sorting. `double precision` (not numeric) so node-pg
  // returns a JS number for the haversine math. Populated best-effort by the Geocoder.
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  cmcNumberEncrypted: text("cmc_number_encrypted"),
  // CMC registration numbers are public professional identifiers. Keep a display
  // copy for the patient-facing verified profile and the HMAC for uniqueness.
  // NIC remains encrypted and admin-only.
  cmcNumber: text("cmc_number"),
  cmcNumberHmac: text("cmc_number_hmac").unique(),
  nicNumberEncrypted: text("nic_number_encrypted"),
  nicNumberHmac: text("nic_number_hmac").unique(),
  cmcCertificateFileKey: text("cmc_certificate_file_key"),
  cmcCertificateUploadedAt: timestamp("cmc_certificate_uploaded_at", { withTimezone: true }),
  nicFileKey: text("nic_file_key"),
  nicUploadedAt: timestamp("nic_uploaded_at", { withTimezone: true }),
  profilePhotoFileKey: text("profile_photo_file_key"),
  profilePhotoUploadedAt: timestamp("profile_photo_uploaded_at", { withTimezone: true }),
  verificationStatus: verificationStatusEnum("verification_status").notNull().default("incomplete"),
  verificationSubmittedAt: timestamp("verification_submitted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
