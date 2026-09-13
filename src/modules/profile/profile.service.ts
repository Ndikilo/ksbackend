import { SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";
import type { Profile, ProfilePatch } from "@/domain/profile/profile";
import { NotFound, ValidationFailed } from "@/domain/shared/errors";
import { IdGenerator } from "@/infra/ids";
import { FileStorage, type PresignedUpload, type StorageError } from "@/infra/storage";
import { ProfileRepo } from "./profile.repo";

const AVATAR_CONTENT_TYPES = new Set(["image/jpeg", "image/png"]);
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

export interface ProfileServiceService {
  readonly get: (userId: string) => Effect.Effect<Profile, NotFound | SqlError.SqlError>;
  readonly update: (
    userId: string,
    patch: ProfilePatch,
  ) => Effect.Effect<Profile, NotFound | ValidationFailed | SqlError.SqlError>;
  readonly presignAvatar: (
    userId: string,
    contentType: string,
  ) => Effect.Effect<PresignedUpload, ValidationFailed | StorageError>;
  readonly updateLocale: (
    userId: string,
    locale: "en" | "fr",
  ) => Effect.Effect<void, NotFound | SqlError.SqlError>;
}

export class ProfileService extends Context.Tag("ProfileService")<
  ProfileService,
  ProfileServiceService
>() {}

/** Avatar keys are namespaced by user, so a client can't claim another's upload. */
const avatarPrefix = (userId: string) => `profile-photos/${userId}/`;

const orNotFound = (found: Profile | undefined): Effect.Effect<Profile, NotFound> =>
  found === undefined ? Effect.fail(new NotFound({ resource: "Profile" })) : Effect.succeed(found);

export const ProfileServiceLive = Layer.effect(
  ProfileService,
  Effect.gen(function* () {
    const repo = yield* ProfileRepo;
    const storage = yield* FileStorage;
    const ids = yield* IdGenerator;

    return {
      get: (userId) => repo.findByUserId(userId).pipe(Effect.flatMap(orNotFound)),

      update: (userId, patch) =>
        Effect.gen(function* () {
          // An avatar key must belong to this user (it's set from presignAvatar,
          // which namespaces by userId) — never trust a client-supplied path.
          if (
            patch.avatarFileKey !== undefined &&
            !patch.avatarFileKey.startsWith(avatarPrefix(userId))
          ) {
            return yield* Effect.fail(
              new ValidationFailed({
                issues: [{ path: "avatarFileKey", message: "Avatar key does not belong to you." }],
              }),
            );
          }
          const now = new Date(yield* Clock.currentTimeMillis);
          const updated = yield* repo.patch(userId, patch, now);
          return yield* orNotFound(updated);
        }),

      presignAvatar: (userId, contentType) =>
        Effect.gen(function* () {
          if (!AVATAR_CONTENT_TYPES.has(contentType)) {
            return yield* Effect.fail(
              new ValidationFailed({
                issues: [{ path: "contentType", message: "Avatar must be a JPEG or PNG." }],
              }),
            );
          }
          const uuid = yield* ids.next;
          return yield* storage.presignUpload({
            key: `${avatarPrefix(userId)}${uuid}`,
            contentType,
            maxBytes: AVATAR_MAX_BYTES,
          });
        }),
      updateLocale: (userId, locale) =>
        repo
          .updateLocale(userId, locale)
          .pipe(
            Effect.flatMap((updated) =>
              updated ? Effect.void : Effect.fail(new NotFound({ resource: "Account" })),
            ),
          ),
    };
  }),
);
