import { SqlClient, SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";
import type {
  AvailabilityException,
  AvailabilityExceptionInput,
  AvailabilityRule,
  AvailabilityRuleInput,
  AvailabilitySlot,
  PublicAvailabilitySlot,
  SlotInput,
} from "@/domain/availability/availability";
import { expandSchedule } from "@/domain/availability/schedule";
import { SlotOverlap } from "@/domain/availability/errors";
import { Conflict, Forbidden, NotFound, ValidationFailed } from "@/domain/shared/errors";
import { CurrentUser } from "@/infra/auth";
import { requireAnyRole } from "@/infra/authz";
import { IdGenerator } from "@/infra/ids";
import { decodeCursor, encodeCursor } from "@/lib/cursor";
import { PractitionerRepo } from "@/modules/practitioner/practitioner.repo";
import { LocationRepo } from "@/modules/location/location.repo";
import { AvailabilityRepo } from "./availability.repo";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;
const dateKey = (date: Date): string =>
  new Date(date.getTime() + 3_600_000).toISOString().slice(0, 10);
const timeMinutes = (time: string): number => {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  return hours * 60 + minutes;
};
const weeklyInterval = (rule: AvailabilityRuleInput): readonly [number, number] => {
  const start = rule.weekday * DAY_MINUTES + timeMinutes(rule.startTime);
  const rawEnd = rule.weekday * DAY_MINUTES + timeMinutes(rule.endTime);
  return [start, rawEnd > start ? rawEnd : rawEnd + DAY_MINUTES];
};
const rulesOverlap = (left: AvailabilityRuleInput, right: AvailabilityRuleInput): boolean => {
  const [leftStart, leftEnd] = weeklyInterval(left);
  const [rightStart, rightEnd] = weeklyInterval(right);
  return [-WEEK_MINUTES, 0, WEEK_MINUTES].some((shift) => {
    const shiftedStart = rightStart + shift;
    const shiftedEnd = rightEnd + shift;
    return leftStart < shiftedEnd && leftEnd > shiftedStart;
  });
};

export type SlotPage = {
  readonly data: ReadonlyArray<AvailabilitySlot>;
  readonly meta: {
    readonly count: number;
    readonly limit: number;
    readonly nextCursor: string | null;
    readonly hasNextPage: boolean;
  };
};

export type PublicAvailabilityWindow = {
  readonly data: ReadonlyArray<PublicAvailabilitySlot>;
  readonly from: Date;
  readonly to: Date;
};

export interface AvailabilityServiceService {
  readonly createSlot: (
    userId: string,
    input: SlotInput,
  ) => Effect.Effect<
    AvailabilitySlot,
    Conflict | Forbidden | NotFound | ValidationFailed | SlotOverlap | SqlError.SqlError,
    CurrentUser
  >;
  readonly listMine: (
    userId: string,
    limit: number,
    cursor: string | undefined,
  ) => Effect.Effect<
    SlotPage,
    Conflict | Forbidden | NotFound | ValidationFailed | SqlError.SqlError,
    CurrentUser
  >;
  readonly deleteSlot: (
    userId: string,
    slotId: string,
  ) => Effect.Effect<void, Forbidden | NotFound | SqlError.SqlError, CurrentUser>;
  readonly replaceRules: (
    userId: string,
    rules: ReadonlyArray<AvailabilityRuleInput>,
  ) => Effect.Effect<
    ReadonlyArray<AvailabilityRule>,
    Forbidden | NotFound | ValidationFailed | SqlError.SqlError,
    CurrentUser
  >;
  readonly listRules: (
    userId: string,
  ) => Effect.Effect<
    ReadonlyArray<AvailabilityRule>,
    Forbidden | NotFound | SqlError.SqlError,
    CurrentUser
  >;
  readonly createException: (
    userId: string,
    input: AvailabilityExceptionInput,
  ) => Effect.Effect<
    AvailabilityException,
    Conflict | Forbidden | NotFound | ValidationFailed | SqlError.SqlError,
    CurrentUser
  >;
  readonly deleteException: (
    userId: string,
    id: string,
  ) => Effect.Effect<void, Forbidden | NotFound | SqlError.SqlError, CurrentUser>;
  readonly publicAvailability: (
    practitionerProfileId: string,
    from: Date | undefined,
    to: Date | undefined,
  ) => Effect.Effect<PublicAvailabilityWindow, NotFound | ValidationFailed | SqlError.SqlError>;
  readonly availabilityDays: (
    practitionerProfileId: string,
    month: string,
  ) => Effect.Effect<ReadonlyArray<string>, NotFound | ValidationFailed | SqlError.SqlError>;
  readonly nextAvailableAt: (
    practitionerProfileId: string,
  ) => Effect.Effect<Date | null, NotFound | SqlError.SqlError>;
}

export class AvailabilityService extends Context.Tag("AvailabilityService")<
  AvailabilityService,
  AvailabilityServiceService
>() {}

export const AvailabilityServiceLive = Layer.effect(
  AvailabilityService,
  Effect.gen(function* () {
    const repo = yield* AvailabilityRepo;
    const practitioners = yield* PractitionerRepo;
    const locations = yield* LocationRepo;
    const ids = yield* IdGenerator;
    const sql = yield* SqlClient.SqlClient;

    const requirePractitioner = (userId: string) =>
      requireAnyRole("doctor", "nurse").pipe(
        Effect.zipRight(repo.practitionerIdForUser(userId)),
        Effect.flatMap((id) =>
          id === undefined
            ? Effect.fail(new NotFound({ resource: "Practitioner profile" }))
            : Effect.succeed(id),
        ),
      );

    const requireVerified = (practitionerProfileId: string) =>
      practitioners
        .findById(practitionerProfileId)
        .pipe(
          Effect.flatMap((found) =>
            found?.verificationStatus === "verified"
              ? Effect.void
              : Effect.fail(new NotFound({ resource: "Practitioner", id: practitionerProfileId })),
          ),
        );

    const expand = (practitionerProfileId: string, from: Date, to: Date, now: Date) =>
      Effect.all(
        {
          rules: repo.listRules(practitionerProfileId),
          exceptions: repo.listExceptions(practitionerProfileId, dateKey(from), dateKey(to)),
          explicitSlots: repo.listSlotsInRange(practitionerProfileId, from, to),
        },
        { concurrency: 3 },
      ).pipe(Effect.map((data) => expandSchedule({ ...data, from, to, now })));

    const publicWindow = (
      practitionerProfileId: string,
      requestedFrom: Date | undefined,
      requestedTo: Date | undefined,
    ) =>
      Effect.gen(function* () {
        yield* requireVerified(practitionerProfileId);
        const now = new Date(yield* Clock.currentTimeMillis);
        const from = requestedFrom ?? now;
        const to = requestedTo ?? new Date(from.getTime() + 14 * 86_400_000);
        const rangeMs = to.getTime() - from.getTime();
        if (rangeMs <= 0 || rangeMs > 60 * 86_400_000) {
          return yield* Effect.fail(
            new ValidationFailed({
              issues: [
                { path: "to", message: "Availability range must be between 1 and 60 days." },
              ],
            }),
          );
        }
        return { data: yield* expand(practitionerProfileId, from, to, now), from, to };
      });

    return {
      createSlot: (userId, input) =>
        Effect.gen(function* () {
          const practitionerId = yield* requirePractitioner(userId);
          const now = new Date(yield* Clock.currentTimeMillis);
          if (
            input.locationId !== null &&
            !(yield* locations.list(practitionerId)).some(
              (location) => location.id === input.locationId,
            )
          ) {
            return yield* Effect.fail(
              new ValidationFailed({
                issues: [
                  { path: "locationId", message: "Location is not owned by this practitioner." },
                ],
              }),
            );
          }
          if (input.endsAt.getTime() <= input.startsAt.getTime()) {
            return yield* Effect.fail(
              new ValidationFailed({
                issues: [{ path: "endsAt", message: "endsAt must be after startsAt." }],
              }),
            );
          }
          if (input.startsAt.getTime() <= now.getTime()) {
            return yield* Effect.fail(
              new ValidationFailed({
                issues: [{ path: "startsAt", message: "startsAt must be in the future." }],
              }),
            );
          }
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const clash = yield* repo.overlaps(practitionerId, input.startsAt, input.endsAt);
              if (clash) {
                return yield* Effect.fail(new SlotOverlap({}));
              }
              const id = input.id ?? (yield* ids.next);
              if (input.id !== undefined && (yield* repo.slotIdExists(input.id))) {
                return yield* Effect.fail(
                  new Conflict({ resource: "Availability slot", reason: "ID is already in use." }),
                );
              }
              return yield* repo.insert({
                id,
                practitionerProfileId: practitionerId,
                startsAt: input.startsAt,
                endsAt: input.endsAt,
                consultationTypes: input.consultationTypes,
                locationId: input.locationId,
                createdAt: now,
                updatedAt: now,
              });
            }),
          );
        }),

      listMine: (userId, limit, cursor) =>
        Effect.gen(function* () {
          const practitionerId = yield* requirePractitioner(userId);
          let beforeId: string | undefined;
          if (cursor !== undefined) {
            const decoded = decodeCursor(cursor);
            if (!UUID_RE.test(decoded)) {
              return yield* Effect.fail(
                new ValidationFailed({ issues: [{ path: "cursor", message: "Invalid cursor." }] }),
              );
            }
            beforeId = decoded;
          }
          const rows = yield* repo.listByPractitioner(practitionerId, limit + 1, beforeId);
          const hasNextPage = rows.length > limit;
          const data = hasNextPage ? rows.slice(0, limit) : rows;
          const last = data.at(-1);
          return {
            data,
            meta: {
              count: data.length,
              limit,
              nextCursor: hasNextPage && last ? encodeCursor(last.id) : null,
              hasNextPage,
            },
          };
        }),

      deleteSlot: (userId, slotId) =>
        Effect.gen(function* () {
          const practitionerId = yield* requirePractitioner(userId);
          const now = new Date(yield* Clock.currentTimeMillis);
          const deleted = yield* repo.softDelete(practitionerId, slotId, now);
          if (!deleted) return yield* Effect.fail(new NotFound({ resource: "Availability slot" }));
        }),

      replaceRules: (userId, rules) =>
        Effect.gen(function* () {
          const practitionerProfileId = yield* requirePractitioner(userId);
          const ownedLocationIds = new Set(
            (yield* locations.list(practitionerProfileId)).map((location) => location.id),
          );
          for (const [index, rule] of rules.entries()) {
            if (rule.startTime === rule.endTime) {
              return yield* Effect.fail(
                new ValidationFailed({
                  issues: [
                    {
                      path: `rules.${index}.endTime`,
                      message: "endTime must differ from startTime.",
                    },
                  ],
                }),
              );
            }
            if (rule.validFrom !== null && rule.validTo !== null && rule.validFrom > rule.validTo) {
              return yield* Effect.fail(
                new ValidationFailed({
                  issues: [
                    {
                      path: `rules.${index}.validTo`,
                      message: "validTo must not precede validFrom.",
                    },
                  ],
                }),
              );
            }
            if (rule.locationId !== null && !ownedLocationIds.has(rule.locationId)) {
              return yield* Effect.fail(
                new ValidationFailed({
                  issues: [
                    {
                      path: `rules.${index}.locationId`,
                      message: "Location is not owned by this practitioner.",
                    },
                  ],
                }),
              );
            }
            const overlaps = rules.some(
              (other, otherIndex) => otherIndex < index && rulesOverlap(other, rule),
            );
            if (overlaps) {
              return yield* Effect.fail(
                new ValidationFailed({
                  issues: [
                    { path: `rules.${index}`, message: "Availability rules may not overlap." },
                  ],
                }),
              );
            }
          }
          const now = new Date(yield* Clock.currentTimeMillis);
          const rows = yield* Effect.forEach(rules, (rule) =>
            ids.next.pipe(
              Effect.map((id) => ({
                id,
                practitionerProfileId,
                ...rule,
                consultationTypes: [...rule.consultationTypes],
                createdAt: now,
                updatedAt: now,
              })),
            ),
          );
          return yield* sql.withTransaction(repo.replaceRules(practitionerProfileId, rows));
        }),

      listRules: (userId) => requirePractitioner(userId).pipe(Effect.flatMap(repo.listRules)),

      createException: (userId, input) =>
        Effect.gen(function* () {
          const practitionerProfileId = yield* requirePractitioner(userId);
          if (
            input.kind === "extra" &&
            (input.startTime === null ||
              input.endTime === null ||
              input.startTime === input.endTime)
          ) {
            return yield* Effect.fail(
              new ValidationFailed({
                issues: [
                  {
                    path: "endTime",
                    message: "Extra availability requires different start and end times.",
                  },
                ],
              }),
            );
          }
          if (input.kind === "blocked" && (input.startTime === null) !== (input.endTime === null)) {
            return yield* Effect.fail(
              new ValidationFailed({
                issues: [
                  {
                    path: "endTime",
                    message: "A partial block requires both startTime and endTime.",
                  },
                ],
              }),
            );
          }
          if (
            input.locationId !== null &&
            !(yield* locations.list(practitionerProfileId)).some(
              (location) => location.id === input.locationId,
            )
          ) {
            return yield* Effect.fail(
              new ValidationFailed({
                issues: [
                  { path: "locationId", message: "Location is not owned by this practitioner." },
                ],
              }),
            );
          }
          const now = new Date(yield* Clock.currentTimeMillis);
          const id = input.id ?? (yield* ids.next);
          if (input.id !== undefined && (yield* repo.exceptionIdExists(input.id))) {
            return yield* Effect.fail(
              new Conflict({
                resource: "Availability exception",
                reason: "ID is already in use.",
              }),
            );
          }
          return yield* repo.insertException({
            id,
            practitionerProfileId,
            date: input.date,
            kind: input.kind,
            startTime: input.startTime,
            endTime: input.endTime,
            locationId: input.locationId,
            consultationTypes:
              input.consultationTypes === null ? null : [...input.consultationTypes],
            createdAt: now,
            updatedAt: now,
          });
        }),

      deleteException: (userId, id) =>
        Effect.gen(function* () {
          const removed = yield* repo.softDeleteException(
            yield* requirePractitioner(userId),
            id,
            new Date(yield* Clock.currentTimeMillis),
          );
          if (!removed)
            return yield* Effect.fail(new NotFound({ resource: "Availability exception" }));
        }),

      publicAvailability: publicWindow,

      availabilityDays: (practitionerProfileId, month) => {
        const [year = 0, monthNumber = 0] = month.split("-").map(Number);
        const from = new Date(Date.UTC(year, monthNumber - 1, 1, -1));
        const to = new Date(Date.UTC(year, monthNumber, 1, -1));
        return publicWindow(practitionerProfileId, from, to).pipe(
          Effect.map(({ data }) => [...new Set(data.map((slot) => dateKey(slot.startsAt)))]),
        );
      },

      nextAvailableAt: (practitionerProfileId) =>
        Effect.gen(function* () {
          yield* requireVerified(practitionerProfileId);
          const now = new Date(yield* Clock.currentTimeMillis);
          const to = new Date(now.getTime() + 60 * 86_400_000);
          return (yield* expand(practitionerProfileId, now, to, now))[0]?.startsAt ?? null;
        }),
    } satisfies AvailabilityServiceService;
  }),
);
