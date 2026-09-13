import { SqlClient, SqlError } from "@effect/sql";
import { Clock, Config, Context, Effect, Layer } from "effect";
import type {
  ConsultationOffering,
  ConsultationOfferingCreateInput,
  ConsultationOfferingPatch,
} from "@/domain/offering/offering";
import { Conflict, NotFound } from "@/domain/shared/errors";
import { IdGenerator } from "@/infra/ids";
import { PractitionerRepo } from "@/modules/practitioner/practitioner.repo";
import { OfferingRepo } from "./offering.repo";
export interface OfferingServiceService {
  readonly listMine: (
    userId: string,
  ) => Effect.Effect<ReadonlyArray<ConsultationOffering>, NotFound | SqlError.SqlError>;
  readonly create: (
    userId: string,
    input: ConsultationOfferingCreateInput,
  ) => Effect.Effect<ConsultationOffering, Conflict | NotFound | SqlError.SqlError>;
  readonly update: (
    userId: string,
    id: string,
    input: ConsultationOfferingPatch,
  ) => Effect.Effect<ConsultationOffering, Conflict | NotFound | SqlError.SqlError>;
  readonly remove: (
    userId: string,
    id: string,
  ) => Effect.Effect<void, NotFound | SqlError.SqlError>;
  readonly earningsTerms: Effect.Effect<{
    readonly commissionBps: number;
    readonly commissionPercent: number;
  }>;
}
export class OfferingService extends Context.Tag("OfferingService")<
  OfferingService,
  OfferingServiceService
>() {}
export const OfferingServiceLive = Layer.effect(
  OfferingService,
  Effect.gen(function* () {
    const repo = yield* OfferingRepo;
    const practitioners = yield* PractitionerRepo;
    const ids = yield* IdGenerator;
    const sql = yield* SqlClient.SqlClient;
    const commissionBps = yield* Config.integer("PLATFORM_COMMISSION_BPS").pipe(
      Config.withDefault(2000),
    );
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
      listMine: (userId) => ownerId(userId).pipe(Effect.flatMap((id) => repo.list(id, false))),
      create: (userId, input) =>
        Effect.gen(function* () {
          const practitionerProfileId = yield* ownerId(userId);
          const id = input.id ?? (yield* ids.next);
          if (input.id !== undefined && (yield* repo.idExists(input.id))) {
            return yield* Effect.fail(
              new Conflict({ resource: "Consultation offering", reason: "ID is already in use." }),
            );
          }
          if (
            yield* repo.hasDuplicate(
              practitionerProfileId,
              input.consultationType,
              input.durationMin,
              undefined,
            )
          ) {
            return yield* Effect.fail(
              new Conflict({
                resource: "Consultation offering",
                reason: "This consultation type and duration already exists.",
              }),
            );
          }
          const now = new Date(yield* Clock.currentTimeMillis);
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const created = yield* repo.insert({
                id,
                practitionerProfileId,
                consultationType: input.consultationType,
                durationMin: input.durationMin,
                priceXaf: input.priceXaf,
                active: input.active,
                createdAt: now,
                updatedAt: now,
              });
              yield* repo.syncMinimumFee(practitionerProfileId, now);
              return created;
            }),
          );
        }),
      update: (userId, id, input) =>
        Effect.gen(function* () {
          const practitionerProfileId = yield* ownerId(userId);
          const existing = yield* repo.findOwned(practitionerProfileId, id);
          if (existing === undefined)
            return yield* Effect.fail(new NotFound({ resource: "Consultation offering" }));
          const nextType = input.consultationType ?? existing.consultationType;
          const nextDuration = input.durationMin ?? existing.durationMin;
          if (yield* repo.hasDuplicate(practitionerProfileId, nextType, nextDuration, id)) {
            return yield* Effect.fail(
              new Conflict({
                resource: "Consultation offering",
                reason: "This consultation type and duration already exists.",
              }),
            );
          }
          const now = new Date(yield* Clock.currentTimeMillis);
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const found = yield* repo.update(practitionerProfileId, id, input, now);
              if (found === undefined)
                return yield* Effect.fail(new NotFound({ resource: "Consultation offering" }));
              yield* repo.syncMinimumFee(practitionerProfileId, now);
              return found;
            }),
          );
        }),
      remove: (userId, id) =>
        Effect.gen(function* () {
          const practitionerProfileId = yield* ownerId(userId);
          const now = new Date(yield* Clock.currentTimeMillis);
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const removed = yield* repo.softDelete(practitionerProfileId, id, now);
              if (!removed)
                return yield* Effect.fail(new NotFound({ resource: "Consultation offering" }));
              yield* repo.syncMinimumFee(practitionerProfileId, now);
            }),
          );
        }),
      earningsTerms: Effect.succeed({ commissionBps, commissionPercent: commissionBps / 100 }),
    } satisfies OfferingServiceService;
  }),
);
