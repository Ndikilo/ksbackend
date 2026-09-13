import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { language } from "@/db/schema/language";
import { profession } from "@/db/schema/profession";
import type { LanguageReference, ProfessionReference } from "@/domain/reference/reference";

export interface ReferenceRepoService {
  readonly listProfessions: (
    limit: number,
    beforeId: string | undefined,
  ) => Effect.Effect<ReadonlyArray<ProfessionReference>, SqlError.SqlError>;
  readonly listLanguages: (
    limit: number,
    beforeId: string | undefined,
  ) => Effect.Effect<ReadonlyArray<LanguageReference>, SqlError.SqlError>;
  readonly activeLanguageCodes: (
    codes: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlySet<string>, SqlError.SqlError>;
  readonly findLanguages: (
    codes: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<LanguageReference>, SqlError.SqlError>;
  readonly findProfession: (
    id: string,
  ) => Effect.Effect<ProfessionReference | undefined, SqlError.SqlError>;
}

export class ReferenceRepo extends Context.Tag("ReferenceRepo")<
  ReferenceRepo,
  ReferenceRepoService
>() {}

export const ReferenceRepoLive = Layer.effect(
  ReferenceRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    return {
      listProfessions: (limit, beforeId) =>
        db
          .select({
            id: profession.id,
            nameEn: profession.nameEn,
            nameFr: profession.nameFr,
            prefixHint: profession.prefixHint,
          })
          .from(profession)
          .where(
            and(
              eq(profession.active, true),
              beforeId === undefined ? undefined : lt(profession.id, beforeId),
            ),
          )
          .orderBy(desc(profession.id))
          .limit(limit),
      listLanguages: (limit, beforeId) =>
        db
          .select({
            id: language.id,
            code: language.code,
            nameEn: language.nameEn,
            nameFr: language.nameFr,
          })
          .from(language)
          .where(
            and(
              eq(language.active, true),
              beforeId === undefined ? undefined : lt(language.id, beforeId),
            ),
          )
          .orderBy(desc(language.id))
          .limit(limit),
      activeLanguageCodes: (codes) =>
        codes.length === 0
          ? Effect.succeed(new Set<string>())
          : db
              .select({ code: language.code })
              .from(language)
              .where(and(eq(language.active, true), inArray(language.code, [...codes])))
              .pipe(Effect.map((rows) => new Set(rows.map((row) => row.code)))),
      findLanguages: (codes) =>
        codes.length === 0
          ? Effect.succeed([])
          : db
              .select({
                id: language.id,
                code: language.code,
                nameEn: language.nameEn,
                nameFr: language.nameFr,
              })
              .from(language)
              .where(and(eq(language.active, true), inArray(language.code, [...codes]))),
      findProfession: (id) =>
        db
          .select({
            id: profession.id,
            nameEn: profession.nameEn,
            nameFr: profession.nameFr,
            prefixHint: profession.prefixHint,
          })
          .from(profession)
          .where(and(eq(profession.id, id), eq(profession.active, true)))
          .limit(1)
          .pipe(Effect.map((rows) => rows[0])),
    } satisfies ReferenceRepoService;
  }),
);
