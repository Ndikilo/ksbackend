import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { eq, inArray, and } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Context, Effect, Layer } from "effect";

import type { ChannelPreferences, NotificationCategory } from "@/domain/notification/notification";
import { user } from "@/db/schema/auth";
import { notificationPreference } from "@/db/schema/notification-preference";
import { practitionerProfile } from "@/db/schema/practitioner-profile";

/**
 * The identity one lifecycle notification renders against: the account row
 * (better-auth) carries the email (the only addressable channel today), the
 * stored locale (copy is rendered per RECIPIENT, never per requester) and the
 * display name (patient-facing copy names the practitioner, and vice versa).
 */
export type PartyIdentity = {
  readonly userId: string;
  readonly email: string;
  /** The user's stored locale tag (may be anything — normalize before render). */
  readonly locale: string | null;
  readonly name: string;
};

/** Both parties of an appointment, as their notification-facing identities. */
export type AppointmentParties = {
  readonly patient: PartyIdentity;
  readonly practitioner: PartyIdentity;
};

export interface LifecycleRepoService {
  /**
   * The two parties of one appointment. `undefined` only if either account row
   * is gone — both FKs cascade, so a live appointment always has both; the
   * caller skips notifying rather than failing the transition.
   */
  readonly parties: (input: {
    readonly patientUserId: string;
    readonly practitionerProfileId: string;
  }) => Effect.Effect<AppointmentParties | undefined, SqlError.SqlError>;
  /** One account's notification-facing identity (receipt path). */
  readonly userById: (
    userId: string,
  ) => Effect.Effect<PartyIdentity | undefined, SqlError.SqlError>;
  /**
   * The stored preference matrix for the given users under ONE category.
   * Missing rows are absent from the map — the caller falls back to code
   * defaults (the same contract as the reminder scheduler's read).
   */
  readonly preferencesFor: (
    userIds: ReadonlyArray<string>,
    category: NotificationCategory,
  ) => Effect.Effect<ReadonlyMap<string, ChannelPreferences>, SqlError.SqlError>;
}

export class LifecycleRepo extends Context.Tag("LifecycleRepo")<
  LifecycleRepo,
  LifecycleRepoService
>() {}

/** Project a user row onto its notification-facing identity. */
const toIdentity = (row: {
  readonly id: string;
  readonly email: string;
  readonly locale: string | null;
  readonly name: string;
}): PartyIdentity => ({ userId: row.id, email: row.email, locale: row.locale, name: row.name });

export const LifecycleRepoLive = Layer.effect(
  LifecycleRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    // The practitioner's human identity lives on their USER row (better-auth);
    // an aliased join keeps it independent of the patient join (P6.T2 pattern).
    const practitionerUser = alias(user, "practitioner_user");

    return {
      parties: ({ patientUserId, practitionerProfileId }) =>
        db
          .select({
            patientId: user.id,
            patientEmail: user.email,
            patientLocale: user.locale,
            patientName: user.name,
            practitionerId: practitionerUser.id,
            practitionerEmail: practitionerUser.email,
            practitionerLocale: practitionerUser.locale,
            practitionerName: practitionerUser.name,
          })
          .from(user)
          .innerJoin(practitionerProfile, eq(practitionerProfile.id, practitionerProfileId))
          .innerJoin(practitionerUser, eq(practitionerProfile.userId, practitionerUser.id))
          .where(eq(user.id, patientUserId))
          .limit(1)
          .pipe(
            Effect.map((rows) => {
              const row = rows[0];
              return row === undefined
                ? undefined
                : {
                    patient: {
                      userId: row.patientId,
                      email: row.patientEmail,
                      locale: row.patientLocale,
                      name: row.patientName,
                    },
                    practitioner: {
                      userId: row.practitionerId,
                      email: row.practitionerEmail,
                      locale: row.practitionerLocale,
                      name: row.practitionerName,
                    },
                  };
            }),
          ),

      userById: (userId) =>
        db
          .select({
            id: user.id,
            email: user.email,
            locale: user.locale,
            name: user.name,
          })
          .from(user)
          .where(eq(user.id, userId))
          .limit(1)
          .pipe(Effect.map((rows) => (rows[0] ? toIdentity(rows[0]) : undefined))),

      preferencesFor: (userIds, category) => {
        if (userIds.length === 0) return Effect.succeed(new Map<string, ChannelPreferences>());
        return db
          .select({
            userId: notificationPreference.userId,
            email: notificationPreference.email,
            sms: notificationPreference.sms,
            push: notificationPreference.push,
          })
          .from(notificationPreference)
          .where(
            and(
              eq(notificationPreference.category, category),
              inArray(notificationPreference.userId, [...userIds]),
            ),
          )
          .pipe(
            Effect.map((rows) => {
              const byUser = new Map<string, ChannelPreferences>();
              for (const row of rows) {
                byUser.set(row.userId, { email: row.email, sms: row.sms, push: row.push });
              }
              return byUser;
            }),
          );
      },
    };
  }),
);
