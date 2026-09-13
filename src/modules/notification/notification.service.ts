import { SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";
import {
  defaultChannels,
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationPreference,
} from "@/domain/notification/notification";
import { IdGenerator } from "@/infra/ids";
import { NotificationRepo } from "./notification.repo";

export interface NotificationServiceService {
  /** The full matrix: every category, with stored channels or defaults. */
  readonly get: (
    userId: string,
  ) => Effect.Effect<ReadonlyArray<NotificationPreference>, SqlError.SqlError>;
  /** Upsert the given categories, then return the full matrix. */
  readonly update: (
    userId: string,
    changes: ReadonlyArray<NotificationPreference>,
  ) => Effect.Effect<ReadonlyArray<NotificationPreference>, SqlError.SqlError>;
}

export class NotificationService extends Context.Tag("NotificationService")<
  NotificationService,
  NotificationServiceService
>() {}

const fillDefaults = (
  stored: ReadonlyArray<NotificationPreference>,
): ReadonlyArray<NotificationPreference> => {
  const byCategory = new Map<NotificationCategory, NotificationPreference>(
    stored.map((p) => [p.category, p]),
  );
  return NOTIFICATION_CATEGORIES.map(
    (category) => byCategory.get(category) ?? { category, ...defaultChannels(category) },
  );
};

export const NotificationServiceLive = Layer.effect(
  NotificationService,
  Effect.gen(function* () {
    const repo = yield* NotificationRepo;
    const ids = yield* IdGenerator;

    return {
      get: (userId) => repo.findByUserId(userId).pipe(Effect.map(fillDefaults)),

      update: (userId, changes) =>
        Effect.gen(function* () {
          const now = new Date(yield* Clock.currentTimeMillis);
          yield* Effect.forEach(
            changes,
            (change) =>
              Effect.gen(function* () {
                const id = yield* ids.next;
                yield* repo.upsert(
                  {
                    id,
                    userId,
                    category: change.category,
                    email: change.email,
                    sms: change.sms,
                    push: change.push,
                  },
                  now,
                );
              }),
            { discard: true },
          );
          return fillDefaults(yield* repo.findByUserId(userId));
        }),
    };
  }),
);
