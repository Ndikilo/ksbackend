import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { ErrorResponse } from "@/http/schemas";
import { PatientSearchQuery, PatientSearchResponse } from "./search.contract";
import { PatientSearchService } from "./search.service";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });

const search = createRoute({
  method: "get",
  path: "/v1/patients",
  tags: ["Search"],
  summary: "Search patients (admin only)",
  description: [
    "ADMIN-ONLY patient lookup. Returns non-sensitive identity (id, userId, name) as offset-paged",
    "cards — never the emergency contact, phone, date of birth, or any identifier. `q` is a",
    "typo-tolerant free-text match over the patient's name; sort by `name` or `recency`. Any",
    "non-admin caller gets `403`. This is the same reusable search foundation as practitioner",
    "discovery, applied to a second entity with a stricter authorization gate.",
  ].join(" "),
  request: { query: PatientSearchQuery },
  responses: {
    200: { ...jsonBody(PatientSearchResponse), description: "A page of matching patient cards." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: { ...jsonBody(ErrorResponse), description: "Caller is not an admin." },
  },
});

export const registerPatientSearchRoutes = (
  app: OpenAPIHono<AppEnv>,
  runtime: AppRuntime,
): void => {
  const { runAuth } = makeRun(runtime);

  app.openapi(search, (c) => {
    const query = c.req.valid("query");
    return runAuth(
      c,
      Effect.gen(function* () {
        const service = yield* PatientSearchService;
        const page = yield* service.search(query);
        return c.json({ data: page.data.map((p) => ({ ...p })), meta: page.meta }, 200);
      }),
    );
  });
};
