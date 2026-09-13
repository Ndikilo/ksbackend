import { SqlError } from "@effect/sql";
import { Context, Effect, Layer } from "effect";
import {
  type PatientSort,
  type PatientSortField,
  PATIENT_SORT_DEFAULT_DIRECTION,
  type SortDirection,
} from "@/domain/patient/search";
import type { Forbidden } from "@/domain/shared/errors";
import { CurrentUser } from "@/infra/auth";
import { requireRole } from "@/infra/authz";
import { offsetMeta, offsetOf, type OffsetPage } from "@/lib/offset";
import { PatientSearchRepo } from "./search.repo";

/** The validated query the route hands to the service. */
export type PatientSearchParams = {
  readonly page: number;
  readonly pageSize: number;
  readonly order?: SortDirection | undefined;
  readonly sort: PatientSortField;
  readonly q?: string | undefined;
};

export type PatientSearchItem = {
  readonly id: string;
  readonly surname: string;
  readonly givenNames: string;
};

export interface PatientSearchServiceService {
  readonly search: (
    params: PatientSearchParams,
  ) => Effect.Effect<OffsetPage<PatientSearchItem>, Forbidden | SqlError.SqlError, CurrentUser>;
}

export class PatientSearchService extends Context.Tag("PatientSearchService")<
  PatientSearchService,
  PatientSearchServiceService
>() {}

export const PatientSearchServiceLive = Layer.effect(
  PatientSearchService,
  Effect.gen(function* () {
    const repo = yield* PatientSearchRepo;

    return {
      search: (params) =>
        Effect.gen(function* () {
          // Patient data is sensitive — only admins may enumerate patients.
          yield* requireRole("admin");
          const direction = params.order ?? PATIENT_SORT_DEFAULT_DIRECTION[params.sort];
          const sort: PatientSort = { field: params.sort, direction };
          const { rows, total } = yield* repo.search({ q: params.q }, sort, {
            limit: params.pageSize,
            offset: offsetOf(params.page, params.pageSize),
          });
          return {
            data: rows,
            meta: offsetMeta(params.page, params.pageSize, total, rows.length),
          };
        }),
    } satisfies PatientSearchServiceService;
  }),
);
