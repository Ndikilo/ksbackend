import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, eq, gt, inArray, lte } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Context, Effect, Layer } from "effect";

import type { ChannelPreferences } from "@/domain/notification/notification";
import type { ReminderCandidate } from "@/domain/reminder/reminder";
import { user } from "@/db/schema/auth";
import { appointment } from "@/db/schema/appointment";
import { notificationPreference } from "@/db/schema/notification-preference";
import { practitionerProfile } from "@/db/schema/practitioner-profile";

/**
 * A confirmed appointment inside the reminder scan window, joined with
 * everything the rendered notification needs: the patient's identity
 * (recipient + locale) and the practitioner's display name. Judgment (which
 * horizons are due) stays in the pure domain layer.
 */
export type ReminderCandidateRow = ReminderCandidate & {
  readonly patientUserId: string;
  readonly patientEmail: string;
  /** The user's stored locale tag (may be anything — normalize before render). */
  readonly patientLocale: string | null;
  readonly practitionerName: string;
};

export interface ReminderRepoService {
  /**
   * Confirmed appointments that could still owe a reminder: started in the
   * future, within the scan window (the widest horizon — anything further out
   * has no due horizon yet). Ordered by start so logs read chronologically.
   */
  readonly findDueCandidates: (input: {
    readonly now: Date;
    readonly windowMs: number;
  }) => Effect.Effect<ReadonlyArray<ReminderCandidateRow>, SqlError.SqlError>;
  /**
   * The stored `appointments` preference matrix for the given users. Missing
   * rows are absent from the map — the caller falls back to code defaults.
   */
  readonly preferencesFor: (
    userIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, ChannelPreferences>, SqlError.SqlError>;
}

export class ReminderRepo extends Context.Tag("ReminderRepo")<
  ReminderRepo,
  ReminderRepoService
>() {}

export const ReminderRepoLive = Layer.effect(
  ReminderRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    // The practitioner's human name lives on their USER row (better-auth);
    // a second aliased join keeps the patient join independent.
    const practitionerUser = alias(user, "practitioner_user");

    return {
      findDueCandidates: ({ now, windowMs }) =>
        db
          .select({
            id: appointment.id,
            status: appointment.status,
            startsAt: appointment.startsAt,
            createdAt: appointment.createdAt,
            patientUserId: appointment.patientUserId,
            patientEmail: user.email,
            patientLocale: user.locale,
            practitionerName: practitionerUser.name,
          })
          .from(appointment)
          .innerJoin(user, eq(appointment.patientUserId, user.id))
          .innerJoin(
            practitionerProfile,
            eq(appointment.practitionerProfileId, practitionerProfile.id),
          )
          .innerJoin(practitionerUser, eq(practitionerProfile.userId, practitionerUser.id))
          .where(
            and(
              eq(appointment.status, "confirmed"),
              gt(appointment.startsAt, now),
              lte(appointment.startsAt, new Date(now.getTime() + windowMs)),
            ),
          )
          .orderBy(appointment.startsAt),

      preferencesFor: (userIds) => {
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
              eq(notificationPreference.category, "appointments"),
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
