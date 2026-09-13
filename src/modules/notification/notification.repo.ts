import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { notificationPreference } from "@/db/schema/notification-preference";
import type { NotificationPreference } from "@/domain/notification/notification";

type Row = typeof notificationPreference.$inferSelect;

const toDomain = (row: Row): NotificationPreference => ({
  category: row.category,
  email: row.email,
  sms: row.sms,
  push: row.push,
});

export type PreferenceUpsert = {
  readonly id: string;
  readonly userId: string;
  readonly category: NotificationPreference["category"];
  readonly email: boolean;
  readonly sms: boolean;
  readonly push: boolean;
};

export interface NotificationRepoService {
  readonly findByUserId: (
    userId: string,
  ) => Effect.Effect<ReadonlyArray<NotificationPreference>, SqlError.SqlError>;
  readonly upsert: (
    value: PreferenceUpsert,
    updatedAt: Date,
  ) => Effect.Effect<void, SqlError.SqlError>;
}

export class NotificationRepo extends Context.Tag("NotificationRepo")<
  NotificationRepo,
  NotificationRepoService
>() {}

export const NotificationRepoLive = Layer.effect(
  NotificationRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    return {
      findByUserId: (userId) =>
        db
          .select()
          .from(notificationPreference)
          .where(eq(notificationPreference.userId, userId))
          .pipe(Effect.map((rows) => rows.map(toDomain))),

      upsert: (value, updatedAt) =>
        db
          .insert(notificationPreference)
          .values(value)
          .onConflictDoUpdate({
            target: [notificationPreference.userId, notificationPreference.category],
            set: { email: value.email, sms: value.sms, push: value.push, updatedAt },
          })
          .pipe(Effect.asVoid),
    };
  }),
);
