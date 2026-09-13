import { SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";
import type {
  Qualification,
  QualificationCreateInput,
  QualificationPatch,
} from "@/domain/qualification/qualification";
import { Conflict, NotFound } from "@/domain/shared/errors";
import { IdGenerator } from "@/infra/ids";
import { PractitionerRepo } from "@/modules/practitioner/practitioner.repo";
import { QualificationRepo } from "./qualification.repo";

export interface QualificationServiceService {
  readonly listMine: (
    userId: string,
  ) => Effect.Effect<ReadonlyArray<Qualification>, NotFound | SqlError.SqlError>;
  readonly create: (
    userId: string,
    input: QualificationCreateInput,
  ) => Effect.Effect<Qualification, NotFound | Conflict | SqlError.SqlError>;
  readonly update: (
    userId: string,
    id: string,
    input: QualificationPatch,
  ) => Effect.Effect<Qualification, NotFound | SqlError.SqlError>;
  readonly remove: (
    userId: string,
    id: string,
  ) => Effect.Effect<void, NotFound | SqlError.SqlError>;
}

export class QualificationService extends Context.Tag("QualificationService")<
  QualificationService,
  QualificationServiceService
>() {}

export const QualificationServiceLive = Layer.effect(
  QualificationService,
  Effect.gen(function* () {
    const repo = yield* QualificationRepo;
    const practitioners = yield* PractitionerRepo;
    const ids = yield* IdGenerator;
    const ownerId = (userId: string) =>
      practitioners
        .findByUserId(userId)
        .pipe(
          Effect.flatMap((found) =>
            found
              ? Effect.succeed(found.id)
              : Effect.fail(new NotFound({ resource: "Practitioner profile" })),
          ),
        );
    return {
      listMine: (userId) => ownerId(userId).pipe(Effect.flatMap(repo.list)),
      create: (userId, input) =>
        Effect.gen(function* () {
          const practitionerProfileId = yield* ownerId(userId);
          const count = yield* repo.count(practitionerProfileId);
          if (count >= 20)
            return yield* Effect.fail(
              new Conflict({
                resource: "Qualification",
                reason: "Maximum of 20 qualifications reached.",
              }),
            );
          const now = new Date(yield* Clock.currentTimeMillis);
          const id = input.id ?? (yield* ids.next);
          if (input.id !== undefined && (yield* repo.idExists(input.id))) {
            return yield* Effect.fail(
              new Conflict({ resource: "Qualification", reason: "ID is already in use." }),
            );
          }
          const values = {
            kind: input.kind,
            title: input.title,
            institution: input.institution,
            country: input.country,
            year: input.year,
            sortOrder: input.sortOrder,
          };
          return yield* repo.insert({
            id,
            practitionerProfileId,
            ...values,
            verifiedAt: null,
            createdAt: now,
            updatedAt: now,
          });
        }),
      update: (userId, id, input) =>
        Effect.gen(function* () {
          const updated = yield* repo.update(
            yield* ownerId(userId),
            id,
            input,
            new Date(yield* Clock.currentTimeMillis),
          );
          return updated ?? (yield* Effect.fail(new NotFound({ resource: "Qualification" })));
        }),
      remove: (userId, id) =>
        Effect.gen(function* () {
          const removed = yield* repo.softDelete(
            yield* ownerId(userId),
            id,
            new Date(yield* Clock.currentTimeMillis),
          );
          if (!removed) return yield* Effect.fail(new NotFound({ resource: "Qualification" }));
        }),
    } satisfies QualificationServiceService;
  }),
);
