import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { eq, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { profile } from "@/db/schema/profile";
import { user } from "@/db/schema/auth";
import type { Profile, ProfilePatch } from "@/domain/profile/profile";

type Row = typeof profile.$inferSelect;
type Insert = typeof profile.$inferInsert;

const toDomain = (row: Row): Profile => ({
  id: row.id,
  userId: row.userId,
  surname: row.surname,
  givenNames: row.givenNames,
  phone: row.phone,
  dateOfBirth: row.dateOfBirth,
  sex: row.sex,
  avatarFileKey: row.avatarFileKey,
  consentAcceptedAt: row.consentAcceptedAt,
  consentVersion: row.consentVersion,
});

export interface ProfileRepoService {
  readonly findByUserId: (userId: string) => Effect.Effect<Profile | undefined, SqlError.SqlError>;
  /** Create-or-update the base identity (keyed on userId). Used at registration. */
  readonly upsert: (values: Insert) => Effect.Effect<Profile, SqlError.SqlError>;
  /** Partial edit of the mutable base fields (PATCH /v1/me/profile). */
  readonly patch: (
    userId: string,
    values: ProfilePatch,
    updatedAt: Date,
  ) => Effect.Effect<Profile | undefined, SqlError.SqlError>;
  readonly updateLocale: (
    userId: string,
    locale: "en" | "fr",
  ) => Effect.Effect<boolean, SqlError.SqlError>;
}

export class ProfileRepo extends Context.Tag("ProfileRepo")<ProfileRepo, ProfileRepoService>() {}

export const ProfileRepoLive = Layer.effect(
  ProfileRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    return {
      findByUserId: (userId) =>
        db
          .select()
          .from(profile)
          .where(eq(profile.userId, userId))
          .limit(1)
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),

      upsert: (values) =>
        db
          .insert(profile)
          .values(values)
          // A base profile may already exist (a patient later registers as a
          // practitioner, or vice versa). Names + fresh consent are always
          // provided, but optional identity fields must be PRESERVED when the
          // incoming value is null — otherwise the second role wipes them.
          .onConflictDoUpdate({
            target: profile.userId,
            set: {
              surname: values.surname,
              givenNames: values.givenNames,
              phone: sql`coalesce(excluded.phone, ${profile.phone})`,
              dateOfBirth: sql`coalesce(excluded.date_of_birth, ${profile.dateOfBirth})`,
              sex: sql`coalesce(excluded.sex, ${profile.sex})`,
              consentAcceptedAt: values.consentAcceptedAt,
              consentVersion: values.consentVersion,
              updatedAt: values.consentAcceptedAt,
            },
          })
          .returning()
          .pipe(
            Effect.flatMap((rows) =>
              rows[0]
                ? Effect.succeed(toDomain(rows[0]))
                : Effect.dieMessage("upsert returned no row"),
            ),
          ),

      patch: (userId, values, updatedAt) =>
        db
          .update(profile)
          .set({
            ...(values.surname !== undefined && { surname: values.surname }),
            ...(values.givenNames !== undefined && { givenNames: values.givenNames }),
            ...(values.phone !== undefined && { phone: values.phone }),
            ...(values.dateOfBirth !== undefined && { dateOfBirth: values.dateOfBirth }),
            ...(values.sex !== undefined && { sex: values.sex }),
            ...(values.avatarFileKey !== undefined && { avatarFileKey: values.avatarFileKey }),
            updatedAt,
          })
          .where(eq(profile.userId, userId))
          .returning()
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),
      updateLocale: (userId, locale) =>
        db
          .update(user)
          .set({ locale })
          .where(eq(user.id, userId))
          .returning({ id: user.id })
          .pipe(Effect.map((rows) => rows.length > 0)),
    };
  }),
);
