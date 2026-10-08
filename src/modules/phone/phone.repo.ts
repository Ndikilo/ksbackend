import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { desc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { account, user } from "@/db/schema/auth";
import { phoneIdentity, phoneVerification } from "@/db/schema/phone-identity";
import type { OtpDeliveryChannel, PhoneRegistrationPurpose } from "@/domain/phone/phone";

export type VerificationRow = typeof phoneVerification.$inferSelect;
export type IdentityRow = typeof phoneIdentity.$inferSelect;

export type NewVerification = {
  readonly id: string;
  readonly phone: string;
  readonly purpose: PhoneRegistrationPurpose;
  readonly userId: string | null;
  readonly email: string | null;
  readonly name: string | null;
  /** better-auth password hash — the plaintext password is never persisted. */
  readonly passwordHash: string | null;
  readonly locale: string;
  readonly codeHash: string;
  readonly deliveredVia: OtpDeliveryChannel;
  readonly lastSentAt: Date;
  readonly expiresAt: Date;
};

export type MaterializeSignup = {
  readonly userId: string;
  readonly accountId: string;
  readonly email: string;
  readonly name: string;
  readonly passwordHash: string;
  readonly locale: string;
  /** True when the OTP rode the email channel — possession of the address was proven. */
  readonly emailVerified: boolean;
  readonly identityId: string;
  readonly phone: string;
  readonly channel: OtpDeliveryChannel;
  readonly verifiedAt: Date;
};

export type AttachIdentity = {
  readonly identityId: string;
  readonly userId: string;
  readonly phone: string;
  readonly channel: OtpDeliveryChannel;
  readonly verifiedAt: Date;
};

/**
 * All phone-OTP persistence (P8.T6). Multi-write flows (signup materialization,
 * verification replacement) are composed by the service inside ONE
 * `SqlClient.withTransaction` — the repo itself stays transaction-agnostic,
 * like every other repo.
 */
export interface PhoneRepoService {
  /** Sweep any prior attempts for this phone, then insert the fresh one. */
  readonly replaceVerification: (input: NewVerification) => Effect.Effect<void, SqlError.SqlError>;
  /** The most recent attempt for a phone (consumed or live) — replay detection. */
  readonly findLatestVerification: (
    phone: string,
  ) => Effect.Effect<VerificationRow | undefined, SqlError.SqlError>;
  /** Mark the attempt consumed (single-use; the row stays for replay detection). */
  readonly consumeVerification: (id: string, now: Date) => Effect.Effect<void, SqlError.SqlError>;
  /** Record a wrong-code attempt (and possibly lock the phone). */
  readonly recordVerifyFailure: (
    id: string,
    failedAttempts: number,
    lockedUntil: Date | null,
    now: Date,
  ) => Effect.Effect<void, SqlError.SqlError>;
  /** Drop a pending attempt whose delivery failed — a retry must not hit the cooldown. */
  readonly discardVerification: (id: string) => Effect.Effect<void, SqlError.SqlError>;
  /** Whether this phone is already a verified identity (and whose). */
  readonly identityForPhone: (
    phone: string,
  ) => Effect.Effect<IdentityRow | undefined, SqlError.SqlError>;
  readonly identityForUser: (
    userId: string,
  ) => Effect.Effect<IdentityRow | undefined, SqlError.SqlError>;
  /** Signup materialization: user + credential account + verified identity. */
  readonly materializeSignup: (input: MaterializeSignup) => Effect.Effect<void, SqlError.SqlError>;
  /** Attach (or change) the verified phone of an existing user. */
  readonly upsertIdentity: (input: AttachIdentity) => Effect.Effect<void, SqlError.SqlError>;
  /** Whether an account already exists for this exact email (existence only). */
  readonly emailExists: (email: string) => Effect.Effect<boolean, SqlError.SqlError>;
}

export class PhoneRepo extends Context.Tag("PhoneRepo")<PhoneRepo, PhoneRepoService>() {}

export const PhoneRepoLive = Layer.effect(
  PhoneRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    return {
      replaceVerification: (input) =>
        Effect.gen(function* () {
          yield* db
            .delete(phoneVerification)
            .where(eq(phoneVerification.phone, input.phone))
            .pipe(Effect.asVoid);
          yield* db
            .insert(phoneVerification)
            .values({
              id: input.id,
              phone: input.phone,
              purpose: input.purpose,
              userId: input.userId,
              email: input.email,
              name: input.name,
              passwordHash: input.passwordHash,
              locale: input.locale,
              codeHash: input.codeHash,
              deliveredVia: input.deliveredVia,
              sendCount: 1,
              lastSentAt: input.lastSentAt,
              expiresAt: input.expiresAt,
              failedAttempts: 0,
              lockedUntil: null,
            })
            .pipe(Effect.asVoid);
        }),

      findLatestVerification: (phone) =>
        db
          .select()
          .from(phoneVerification)
          .where(eq(phoneVerification.phone, phone))
          .orderBy(desc(phoneVerification.lastSentAt))
          .limit(1)
          .pipe(Effect.map((rows) => rows[0])),

      consumeVerification: (id, now) =>
        db
          .update(phoneVerification)
          .set({ consumedAt: now, updatedAt: now })
          .where(eq(phoneVerification.id, id))
          .pipe(Effect.asVoid),

      recordVerifyFailure: (id, failedAttempts, lockedUntil, now) =>
        db
          .update(phoneVerification)
          .set({ failedAttempts, lockedUntil, updatedAt: now })
          .where(eq(phoneVerification.id, id))
          .pipe(Effect.asVoid),

      discardVerification: (id) =>
        db.delete(phoneVerification).where(eq(phoneVerification.id, id)).pipe(Effect.asVoid),

      identityForPhone: (phone) =>
        db
          .select()
          .from(phoneIdentity)
          .where(eq(phoneIdentity.phone, phone))
          .limit(1)
          .pipe(Effect.map((rows) => rows[0])),

      identityForUser: (userId) =>
        db
          .select()
          .from(phoneIdentity)
          .where(eq(phoneIdentity.userId, userId))
          .limit(1)
          .pipe(Effect.map((rows) => rows[0])),

      materializeSignup: (input) =>
        Effect.gen(function* () {
          yield* db
            .insert(user)
            .values({
              id: input.userId,
              name: input.name,
              email: input.email,
              emailVerified: input.emailVerified,
              role: "patient",
              locale: input.locale,
            })
            .pipe(Effect.asVoid);
          // The credential account better-auth's email sign-in verifies against
          // (same shape signUpEmail writes: accountId = user id, scrypt hash).
          yield* db
            .insert(account)
            .values({
              id: input.accountId,
              accountId: input.userId,
              providerId: "credential",
              userId: input.userId,
              password: input.passwordHash,
            })
            .pipe(Effect.asVoid);
          yield* db
            .insert(phoneIdentity)
            .values({
              id: input.identityId,
              userId: input.userId,
              phone: input.phone,
              channel: input.channel,
              verifiedAt: input.verifiedAt,
            })
            .pipe(Effect.asVoid);
        }),

      upsertIdentity: (input) =>
        db
          .insert(phoneIdentity)
          .values({
            id: input.identityId,
            userId: input.userId,
            phone: input.phone,
            channel: input.channel,
            verifiedAt: input.verifiedAt,
          })
          .onConflictDoUpdate({
            target: phoneIdentity.userId,
            set: {
              phone: input.phone,
              channel: input.channel,
              verifiedAt: input.verifiedAt,
              updatedAt: input.verifiedAt,
            },
          })
          .pipe(Effect.asVoid),

      emailExists: (email) =>
        db
          .select({ id: user.id })
          .from(user)
          .where(eq(user.email, email))
          .limit(1)
          .pipe(Effect.map((rows) => rows.length > 0)),
    } satisfies PhoneRepoService;
  }),
);
