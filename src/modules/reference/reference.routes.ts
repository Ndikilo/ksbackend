import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { CursorQuery, ErrorResponse } from "@/http/schemas";
import { LanguagesPage, ProfessionsPage } from "./reference.contract";
import { ReferenceService } from "./reference.service";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });

const professions = createRoute({
  method: "get",
  path: "/v1/professions",
  tags: ["Reference"],
  summary: "List active professions",
  request: { query: CursorQuery },
  responses: {
    200: { ...jsonBody(ProfessionsPage), description: "Active professions." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    422: { ...jsonBody(ErrorResponse), description: "Invalid cursor." },
  },
});

const languages = createRoute({
  method: "get",
  path: "/v1/languages",
  tags: ["Reference"],
  summary: "List active languages",
  request: { query: CursorQuery },
  responses: {
    200: { ...jsonBody(LanguagesPage), description: "ISO 639-1 language references." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    422: { ...jsonBody(ErrorResponse), description: "Invalid cursor." },
  },
});

export const registerReferenceRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { runAuth } = makeRun(runtime);
  app.openapi(professions, (c) =>
    runAuth(
      c,
      Effect.flatMap(ReferenceService, (service) => {
        const query = c.req.valid("query");
        return service
          .listProfessions(query.limit, query.cursor)
          .pipe(Effect.map((page) => c.json({ data: [...page.data], meta: page.meta }, 200)));
      }),
    ),
  );
  app.openapi(languages, (c) =>
    runAuth(
      c,
      Effect.flatMap(ReferenceService, (service) => {
        const query = c.req.valid("query");
        return service
          .listLanguages(query.limit, query.cursor)
          .pipe(Effect.map((page) => c.json({ data: [...page.data], meta: page.meta }, 200)));
      }),
    ),
  );
};
