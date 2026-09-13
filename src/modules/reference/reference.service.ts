import { SqlError } from "@effect/sql";
import { Context, Effect, Layer } from "effect";
import type { LanguageReference, ProfessionReference } from "@/domain/reference/reference";
import { ValidationFailed } from "@/domain/shared/errors";
import { decodeCursor, encodeCursor } from "@/lib/cursor";
import { ReferenceRepo } from "./reference.repo";

type Page<A> = {
  readonly data: ReadonlyArray<A>;
  readonly meta: {
    readonly count: number;
    readonly limit: number;
    readonly nextCursor: string | null;
    readonly hasNextPage: boolean;
  };
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const page = <A extends { readonly id: string }>(
  rows: ReadonlyArray<A>,
  limit: number,
): Page<A> => {
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
};

export interface ReferenceServiceService {
  readonly listProfessions: (
    limit: number,
    cursor: string | undefined,
  ) => Effect.Effect<Page<ProfessionReference>, ValidationFailed | SqlError.SqlError>;
  readonly listLanguages: (
    limit: number,
    cursor: string | undefined,
  ) => Effect.Effect<Page<LanguageReference>, ValidationFailed | SqlError.SqlError>;
  readonly validateLanguageCodes: (
    codes: ReadonlyArray<string>,
  ) => Effect.Effect<void, ValidationFailed | SqlError.SqlError>;
  readonly findLanguages: (
    codes: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<LanguageReference>, SqlError.SqlError>;
}

export class ReferenceService extends Context.Tag("ReferenceService")<
  ReferenceService,
  ReferenceServiceService
>() {}

export const ReferenceServiceLive = Layer.effect(
  ReferenceService,
  Effect.gen(function* () {
    const repo = yield* ReferenceRepo;

    const beforeId = (
      cursor: string | undefined,
    ): Effect.Effect<string | undefined, ValidationFailed> => {
      if (cursor === undefined) return Effect.succeed<string | undefined>(undefined);
      const decoded = decodeCursor(cursor);
      return UUID_RE.test(decoded)
        ? Effect.succeed(decoded)
        : Effect.fail(
            new ValidationFailed({ issues: [{ path: "cursor", message: "Invalid cursor." }] }),
          );
    };

    return {
      listProfessions: (limit, cursor) =>
        beforeId(cursor).pipe(
          Effect.flatMap((id) => repo.listProfessions(limit + 1, id)),
          Effect.map((rows) => page(rows, limit)),
        ),
      listLanguages: (limit, cursor) =>
        beforeId(cursor).pipe(
          Effect.flatMap((id) => repo.listLanguages(limit + 1, id)),
          Effect.map((rows) => page(rows, limit)),
        ),
      validateLanguageCodes: (codes) =>
        repo.activeLanguageCodes(codes).pipe(
          Effect.flatMap((active) => {
            const invalid = codes.filter((code) => !active.has(code));
            return invalid.length === 0
              ? Effect.void
              : Effect.fail(
                  new ValidationFailed({
                    issues: invalid.map((code) => ({
                      path: "languagesSpoken",
                      message: `Unknown or inactive ISO 639-1 language code: ${code}.`,
                    })),
                  }),
                );
          }),
        ),
      findLanguages: repo.findLanguages,
    } satisfies ReferenceServiceService;
  }),
);
