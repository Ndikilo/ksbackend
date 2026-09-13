import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { ErrorResponse } from "@/http/schemas";
import { PractitionerSearchQuery, PractitionerSearchResponse } from "./search.contract";
import { type PractitionerSearchItem, PractitionerSearchService } from "./search.service";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });

const round1 = (n: number): number => Math.round(n * 10) / 10;

const toCard = (item: PractitionerSearchItem) => ({
  id: item.id,
  professionId: item.professionId,
  profession: item.profession,
  languages: [...item.languages],
  prefix: item.prefix,
  surname: item.surname,
  givenNames: item.givenNames,
  specialty: item.specialty,
  location: item.location,
  consultationTypes: item.consultationTypes === null ? null : [...item.consultationTypes],
  consultationFeeXaf: item.consultationFeeXaf,
  rating: { average: item.ratingAverage, count: item.ratingCount },
  nextAvailableAt: item.nextAvailableAt === null ? null : item.nextAvailableAt.toISOString(),
  distanceKm: item.distanceKm === null ? null : round1(item.distanceKm),
  photoUrl: item.photoUrl,
});

const search = createRoute({
  method: "get",
  path: "/v1/practitioners",
  tags: ["Search"],
  summary: "Search verified practitioners (result cards)",
  description: [
    "The patient-facing discovery list: verified, active practitioners as result cards showing",
    "name, specialty, location, rating (average + count), next available slot, and consultation",
    "fee. Every filter is optional and independent, so they combine and clear freely: `specialty`,",
    "`city` (matches location), `language`, `consultationType` (comma-separated: in_person, video,",
    "home_visit), `feeMin`/`feeMax`, `professionId` (narrow to a doctor/nurse kind), and free-text",
    "`q` over name/specialty/location. Sort by `availability` (soonest open slot), `distance`,",
    "`rating`, `fee`, `experience`, `name`, or `recency`; `order` overrides the field's natural",
    "direction. Distance requires `lat` & `lng` (the searcher's point) — sorting by distance",
    "without them is a `422`. Offset-paged: read `meta.total`/`pageCount` and pass `page` forward.",
  ].join(" "),
  request: { query: PractitionerSearchQuery },
  responses: {
    200: {
      ...jsonBody(PractitionerSearchResponse),
      description: "A page of matching practitioner cards.",
    },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    422: { ...jsonBody(ErrorResponse), description: "A filter/sort parameter failed validation." },
  },
});

export const registerPractitionerSearchRoutes = (
  app: OpenAPIHono<AppEnv>,
  runtime: AppRuntime,
): void => {
  const { runAuth } = makeRun(runtime);

  app.openapi(search, (c) => {
    const query = c.req.valid("query");
    return runAuth(
      c,
      Effect.gen(function* () {
        const service = yield* PractitionerSearchService;
        const page = yield* service.search(query);
        return c.json({ data: page.data.map(toCard), meta: page.meta }, 200);
      }),
    );
  });
};
