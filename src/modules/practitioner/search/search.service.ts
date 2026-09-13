import { SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";
import { NotFound, ValidationFailed } from "@/domain/shared/errors";
import { CONSULTATION_TYPES, type ConsultationType } from "@/domain/practitioner/practitioner";
import {
  type PractitionerSearchCriteria,
  type PractitionerSort,
  type PractitionerSortField,
  PRACTITIONER_SORT_DEFAULT_DIRECTION,
  type SortDirection,
} from "@/domain/practitioner/search";
import { FileStorage, type StorageError } from "@/infra/storage";
import { offsetMeta, offsetOf, type OffsetPage } from "@/lib/offset";
import { PractitionerSearchRepo } from "./search.repo";
import { ReferenceRepo } from "@/modules/reference/reference.repo";
import { AvailabilityService } from "@/modules/availability/availability.service";
import type { LanguageReference, ProfessionReference } from "@/domain/reference/reference";

/** The validated query the route hands to the service. */
export type PractitionerSearchParams = {
  readonly page: number;
  readonly pageSize: number;
  readonly order?: SortDirection | undefined;
  readonly sort: PractitionerSortField;
  readonly specialty?: string | undefined;
  readonly city?: string | undefined;
  readonly language?: string | undefined;
  readonly consultationType?: string | undefined;
  readonly feeMin?: number | undefined;
  readonly feeMax?: number | undefined;
  readonly professionId?: string | undefined;
  readonly q?: string | undefined;
  readonly lat?: number | undefined;
  readonly lng?: number | undefined;
};

/** A result card with the photo resolved to a presigned URL. */
export type PractitionerSearchItem = {
  readonly id: string;
  readonly professionId: string;
  readonly profession: ProfessionReference;
  readonly languages: ReadonlyArray<LanguageReference>;
  readonly prefix: string | null;
  readonly surname: string;
  readonly givenNames: string;
  readonly specialty: string | null;
  readonly location: string | null;
  readonly consultationTypes: ReadonlyArray<ConsultationType> | null;
  readonly consultationFeeXaf: number | null;
  readonly ratingAverage: number;
  readonly ratingCount: number;
  readonly nextAvailableAt: Date | null;
  readonly distanceKm: number | null;
  readonly photoUrl: string | null;
};

export interface PractitionerSearchServiceService {
  readonly search: (
    params: PractitionerSearchParams,
  ) => Effect.Effect<
    OffsetPage<PractitionerSearchItem>,
    ValidationFailed | NotFound | StorageError | SqlError.SqlError
  >;
}

export class PractitionerSearchService extends Context.Tag("PractitionerSearchService")<
  PractitionerSearchService,
  PractitionerSearchServiceService
>() {}

type Issue = { readonly path: string; readonly message: string };
const AVAILABILITY_SORT_CANDIDATE_LIMIT = 250;

// Parse the comma-separated `consultationType` filter, collecting any unknown value
// as a validation issue rather than throwing.
const parseConsultationTypes = (
  raw: string | undefined,
  issues: Array<Issue>,
): ReadonlyArray<ConsultationType> | undefined => {
  if (raw === undefined) return undefined;
  const parsed: Array<ConsultationType> = [];
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (value === "") continue;
    const found = CONSULTATION_TYPES.find((t) => t === value);
    if (found === undefined) {
      issues.push({ path: "consultationType", message: `Unknown consultation type "${value}".` });
    } else {
      parsed.push(found);
    }
  }
  return parsed.length > 0 ? parsed : undefined;
};

export const PractitionerSearchServiceLive = Layer.effect(
  PractitionerSearchService,
  Effect.gen(function* () {
    const repo = yield* PractitionerSearchRepo;
    const storage = yield* FileStorage;
    const references = yield* ReferenceRepo;
    const availability = yield* AvailabilityService;

    return {
      search: (params) =>
        Effect.gen(function* () {
          const issues: Array<Issue> = [];
          const consultationTypes = parseConsultationTypes(params.consultationType, issues);

          const hasLat = params.lat !== undefined;
          const hasLng = params.lng !== undefined;
          if (hasLat !== hasLng) {
            issues.push({ path: "lat", message: "lat and lng must be provided together." });
          }
          if (
            params.feeMin !== undefined &&
            params.feeMax !== undefined &&
            params.feeMin > params.feeMax
          ) {
            issues.push({
              path: "feeMin",
              message: "feeMin must be less than or equal to feeMax.",
            });
          }
          if (params.sort === "distance" && !(hasLat && hasLng)) {
            issues.push({ path: "sort", message: "Sorting by distance requires lat & lng." });
          }
          if (issues.length > 0) return yield* Effect.fail(new ValidationFailed({ issues }));

          const origin =
            params.lat !== undefined && params.lng !== undefined
              ? { latitude: params.lat, longitude: params.lng }
              : undefined;
          const criteria: PractitionerSearchCriteria = {
            specialty: params.specialty,
            city: params.city,
            language: params.language,
            consultationTypes,
            feeMin: params.feeMin,
            feeMax: params.feeMax,
            professionId: params.professionId,
            q: params.q,
            origin,
          };
          const direction = params.order ?? PRACTITIONER_SORT_DEFAULT_DIRECTION[params.sort];
          const sort: PractitionerSort = { field: params.sort, direction };
          const now = new Date(yield* Clock.currentTimeMillis);

          const requestedOffset = offsetOf(params.page, params.pageSize);
          const availabilitySort = params.sort === "availability";
          const { rows, total } = yield* repo.search(
            criteria,
            sort,
            {
              limit: availabilitySort ? AVAILABILITY_SORT_CANDIDATE_LIMIT + 1 : params.pageSize,
              offset: availabilitySort ? 0 : requestedOffset,
            },
            now,
          );
          if (availabilitySort && total > AVAILABILITY_SORT_CANDIDATE_LIMIT) {
            return yield* Effect.fail(
              new ValidationFailed({
                issues: [
                  {
                    path: "sort",
                    message:
                      "Availability sorting requires filters that narrow the result to 250 practitioners or fewer.",
                  },
                ],
              }),
            );
          }

          // Presigning is a local signing op (no network), but bound the fan-out anyway.
          const data = yield* Effect.forEach(
            rows,
            (r) => {
              const photoUrl: Effect.Effect<string | null, StorageError> =
                r.profilePhotoFileKey === null
                  ? Effect.succeed(null)
                  : storage.presignDownload(r.profilePhotoFileKey);
              return Effect.all({
                photoUrl,
                languages: references.findLanguages(r.languagesSpoken ?? []),
                nextAvailableAt: availability.nextAvailableAt(r.id),
              }).pipe(
                Effect.map(
                  ({ photoUrl: url, languages, nextAvailableAt }): PractitionerSearchItem => ({
                    id: r.id,
                    professionId: r.professionId,
                    profession: {
                      id: r.professionId,
                      nameEn: r.professionNameEn,
                      nameFr: r.professionNameFr,
                      prefixHint: r.professionPrefixHint,
                    },
                    languages,
                    prefix: r.prefix,
                    surname: r.surname,
                    givenNames: r.givenNames,
                    specialty: r.specialty,
                    location: r.location,
                    consultationTypes: r.consultationTypes,
                    consultationFeeXaf: r.consultationFeeXaf,
                    ratingAverage: r.ratingAverage,
                    ratingCount: r.ratingCount,
                    nextAvailableAt,
                    distanceKm: r.distanceKm,
                    photoUrl: url,
                  }),
                ),
              );
            },
            { concurrency: 10 },
          );

          const pageData = availabilitySort
            ? data
                .toSorted((left, right) => {
                  if (left.nextAvailableAt === null) return right.nextAvailableAt === null ? 0 : 1;
                  if (right.nextAvailableAt === null) return -1;
                  const difference =
                    left.nextAvailableAt.getTime() - right.nextAvailableAt.getTime();
                  return direction === "asc" ? difference : -difference;
                })
                .slice(requestedOffset, requestedOffset + params.pageSize)
            : data;
          return {
            data: pageData,
            meta: offsetMeta(params.page, params.pageSize, total, pageData.length),
          };
        }),
    } satisfies PractitionerSearchServiceService;
  }),
);
