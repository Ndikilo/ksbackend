import { SqlClient, SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";
import type {
  PracticeLocation,
  PracticeLocationCreateInput,
  PracticeLocationInput,
  PracticeLocationPatch,
} from "@/domain/location/location";
import { Conflict, NotFound } from "@/domain/shared/errors";
import { Geocoder } from "@/infra/geocoding";
import { IdGenerator } from "@/infra/ids";
import { PractitionerRepo } from "@/modules/practitioner/practitioner.repo";
import { LocationRepo } from "./location.repo";

export interface LocationServiceService {
  readonly listMine: (
    userId: string,
  ) => Effect.Effect<ReadonlyArray<PracticeLocation>, NotFound | SqlError.SqlError>;
  readonly create: (
    userId: string,
    input: PracticeLocationCreateInput,
  ) => Effect.Effect<PracticeLocation, NotFound | Conflict | SqlError.SqlError>;
  readonly update: (
    userId: string,
    id: string,
    input: PracticeLocationPatch,
  ) => Effect.Effect<PracticeLocation, NotFound | SqlError.SqlError>;
  readonly remove: (
    userId: string,
    id: string,
  ) => Effect.Effect<void, Conflict | NotFound | SqlError.SqlError>;
}
export class LocationService extends Context.Tag("LocationService")<
  LocationService,
  LocationServiceService
>() {}

export const LocationServiceLive = Layer.effect(
  LocationService,
  Effect.gen(function* () {
    const repo = yield* LocationRepo;
    const practitioners = yield* PractitionerRepo;
    const geocoder = yield* Geocoder;
    const ids = yield* IdGenerator;
    const sql = yield* SqlClient.SqlClient;
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
    const coordinates = (
      input: Pick<PracticeLocationInput, "addressLine1" | "city" | "region" | "country">,
    ) => geocoder.geocode([input.addressLine1, input.city, input.region, input.country].join(", "));
    const syncPrimaryDisplay = (practitionerProfileId: string, updatedAt: Date) =>
      repo.list(practitionerProfileId).pipe(
        Effect.flatMap((current) => {
          const primary = current.find((location) => location.isPrimary);
          return primary === undefined
            ? repo.clearPrimaryDisplay(practitionerProfileId, updatedAt)
            : repo.syncPrimaryDisplay(practitionerProfileId, primary, updatedAt);
        }),
      );
    return {
      listMine: (userId) => ownerId(userId).pipe(Effect.flatMap(repo.list)),
      create: (userId, input) =>
        Effect.gen(function* () {
          const practitionerProfileId = yield* ownerId(userId);
          if ((yield* repo.count(practitionerProfileId)) >= 5)
            return yield* Effect.fail(
              new Conflict({
                resource: "Practice location",
                reason: "Maximum of five locations reached.",
              }),
            );
          const coords = yield* coordinates(input);
          const now = new Date(yield* Clock.currentTimeMillis);
          const id = input.id ?? (yield* ids.next);
          if (input.id !== undefined && (yield* repo.idExists(input.id))) {
            return yield* Effect.fail(
              new Conflict({ resource: "Practice location", reason: "ID is already in use." }),
            );
          }
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              if (input.isPrimary) yield* repo.clearPrimary(practitionerProfileId, undefined, now);
              const created = yield* repo.insert({
                id,
                practitionerProfileId,
                label: input.label,
                addressLine1: input.addressLine1,
                addressLine2: input.addressLine2 ?? null,
                city: input.city,
                region: input.region,
                country: input.country,
                consultationTypes: input.consultationTypes,
                isPrimary: input.isPrimary,
                latitude: coords?.latitude ?? null,
                longitude: coords?.longitude ?? null,
                createdAt: now,
                updatedAt: now,
              });
              if (created.isPrimary)
                yield* repo.syncPrimaryDisplay(practitionerProfileId, created, now);
              return created;
            }),
          );
        }),
      update: (userId, id, input) =>
        Effect.gen(function* () {
          const practitionerProfileId = yield* ownerId(userId);
          const existing = yield* repo.findOwned(practitionerProfileId, id);
          if (existing === undefined)
            return yield* Effect.fail(new NotFound({ resource: "Practice location" }));
          const merged = {
            label: input.label ?? existing.label,
            addressLine1: input.addressLine1 ?? existing.addressLine1,
            addressLine2:
              input.addressLine2 === undefined ? existing.addressLine2 : input.addressLine2,
            city: input.city ?? existing.city,
            region: input.region ?? existing.region,
            country: input.country ?? existing.country,
            consultationTypes: input.consultationTypes ?? existing.consultationTypes,
            isPrimary: input.isPrimary ?? existing.isPrimary,
          };
          const coords = yield* coordinates(merged);
          const now = new Date(yield* Clock.currentTimeMillis);
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              if (merged.isPrimary) yield* repo.clearPrimary(practitionerProfileId, id, now);
              const updated = yield* repo.update(
                practitionerProfileId,
                id,
                {
                  ...merged,
                  latitude: coords?.latitude ?? null,
                  longitude: coords?.longitude ?? null,
                },
                now,
              );
              if (updated === undefined)
                return yield* Effect.fail(new NotFound({ resource: "Practice location" }));
              yield* syncPrimaryDisplay(practitionerProfileId, now);
              return updated;
            }),
          );
        }),
      remove: (userId, id) =>
        Effect.gen(function* () {
          const practitionerProfileId = yield* ownerId(userId);
          const now = new Date(yield* Clock.currentTimeMillis);
          if ((yield* repo.findOwned(practitionerProfileId, id)) === undefined) {
            return yield* Effect.fail(new NotFound({ resource: "Practice location" }));
          }
          if (yield* repo.isInUse(id)) {
            return yield* Effect.fail(
              new Conflict({
                resource: "Practice location",
                reason: "Location is still referenced by availability.",
              }),
            );
          }
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const removed = yield* repo.softDelete(practitionerProfileId, id, now);
              if (removed === undefined)
                return yield* Effect.fail(new NotFound({ resource: "Practice location" }));
              if (removed.isPrimary) yield* syncPrimaryDisplay(practitionerProfileId, now);
            }),
          );
        }),
    } satisfies LocationServiceService;
  }),
);
