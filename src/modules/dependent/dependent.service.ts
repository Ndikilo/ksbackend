import { SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";
import type { Dependent, DependentInput, DependentPatch } from "@/domain/dependent/dependent";
import { NotFound, ValidationFailed } from "@/domain/shared/errors";
import { IdGenerator } from "@/infra/ids";
import { decodeCursor, encodeCursor } from "@/lib/cursor";
import { DependentRepo } from "./dependent.repo";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DependentPage = {
  readonly data: ReadonlyArray<Dependent>;
  readonly meta: {
    readonly count: number;
    readonly limit: number;
    readonly nextCursor: string | null;
    readonly hasNextPage: boolean;
  };
};

export interface DependentServiceService {
  readonly create: (
    ownerId: string,
    input: DependentInput,
  ) => Effect.Effect<Dependent, SqlError.SqlError>;
  readonly list: (
    ownerId: string,
    limit: number,
    cursor: string | undefined,
  ) => Effect.Effect<DependentPage, ValidationFailed | SqlError.SqlError>;
  readonly get: (
    ownerId: string,
    id: string,
  ) => Effect.Effect<Dependent, NotFound | SqlError.SqlError>;
  readonly update: (
    ownerId: string,
    id: string,
    patch: DependentPatch,
  ) => Effect.Effect<Dependent, NotFound | SqlError.SqlError>;
  readonly remove: (
    ownerId: string,
    id: string,
  ) => Effect.Effect<void, NotFound | SqlError.SqlError>;
}

export class DependentService extends Context.Tag("DependentService")<
  DependentService,
  DependentServiceService
>() {}

export const DependentServiceLive = Layer.effect(
  DependentService,
  Effect.gen(function* () {
    const repo = yield* DependentRepo;
    const ids = yield* IdGenerator;

    const create: DependentServiceService["create"] = (ownerId, input) =>
      Effect.gen(function* () {
        const dependentId = yield* ids.next;
        const linkId = yield* ids.next;
        const now = new Date(yield* Clock.currentTimeMillis);
        return yield* repo.create({
          caregiverId: ownerId,
          dependentId,
          linkId,
          values: input,
          now,
        });
      });

    const list: DependentServiceService["list"] = (ownerId, limit, cursor) =>
      Effect.gen(function* () {
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
        const rows = yield* repo.listByCaregiver(ownerId, limit + 1, beforeId);
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
      });

    const get: DependentServiceService["get"] = (ownerId, id) =>
      repo
        .findForCaregiver(ownerId, id)
        .pipe(
          Effect.flatMap((found) =>
            found === undefined
              ? Effect.fail(new NotFound({ resource: "Dependent", id }))
              : Effect.succeed(found),
          ),
        );

    const update: DependentServiceService["update"] = (ownerId, id, patch) =>
      Effect.gen(function* () {
        // An empty patch is a no-op read — the repo skips the empty `.set({})`.
        const now = new Date(yield* Clock.currentTimeMillis);
        const updated = yield* repo.update(ownerId, id, patch, now);
        return updated === undefined
          ? yield* Effect.fail(new NotFound({ resource: "Dependent", id }))
          : updated;
      });

    const remove: DependentServiceService["remove"] = (ownerId, id) =>
      Effect.gen(function* () {
        const now = new Date(yield* Clock.currentTimeMillis);
        const deleted = yield* repo.unlink(ownerId, id, now);
        if (!deleted) {
          return yield* Effect.fail(new NotFound({ resource: "Dependent", id }));
        }
      });

    return { create, list, get, update, remove };
  }),
);
