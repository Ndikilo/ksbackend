import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { phoneOtpChannelEnum, phoneRegistrationPurposeEnum } from "./enums";

/**
 * Phone identity (P8.T6). Two concerns, two tables:
 *
 * - `phone_verification` — the LIVE OTP attempt: one row per phone with a
 *   HASHED code (never plaintext), a short TTL, a resend timestamp, and the
 *   verify-failure bookkeeping (attempts + lockout). The signup variant
 *   carries the would-be account fields (email/name/locale + the better-auth
 *   PASSWORD HASH so no plaintext ever touches the row) until verify
 *   materializes the user; the attach variant carries the caller's userId.
 *   A partial UNIQUE index on `phone` (live rows only) guarantees one pending
 *   attempt per phone; consumed rows linger for replay detection and are
 *   swept the next time the same phone starts a new attempt.
 *
 * - `phone_identity` — the VERIFIED phone of a user (unique per user, and one
 *   user per phone). This is the durable fact the OTP flow exists to produce.
 */
export const phoneVerification = pgTable(
  "phone_verification",
  {
    id: uuid("id").primaryKey(),
    phone: text("phone").notNull().unique(),
    purpose: phoneRegistrationPurposeEnum("purpose").notNull(),
    /** Attach flow: the signed-in user the verified phone will belong to. */
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    /** Signup flow: the account fields materialized on successful verify. */
    email: text("email"),
    name: text("name"),
    passwordHash: text("password_hash"),
    locale: text("locale").notNull().default("fr"),
    /** HMAC over phone+code — the code itself is never stored. */
    codeHash: text("code_hash").notNull(),
    /** The channel that actually carried the code (drives emailVerified on signup). */
    deliveredVia: phoneOtpChannelEnum("delivered_via").notNull(),
    sendCount: integer("send_count").notNull().default(1),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    /** Set when the code was consumed — consumed rows are history (replay detection). */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("phone_verification_user_id_idx").on(table.userId),
    // One LIVE attempt per phone; consumed rows are kept for replay detection.
    uniqueIndex("phone_verification_live_phone_uq")
      .on(table.phone)
      .where(sql`consumed_at IS NULL`),
  ],
);

export const phoneIdentity = pgTable("phone_identity", {
  id: uuid("id").primaryKey(),
  /** One verified phone per user (upserted when the user changes numbers). */
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  /** One user per verified phone. */
  phone: text("phone").notNull().unique(),
  /** How the number was proven (sms / email fallback / dev surfacing). */
  channel: phoneOtpChannelEnum("channel").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
