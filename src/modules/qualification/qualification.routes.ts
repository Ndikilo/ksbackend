import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { Qualification } from "@/domain/qualification/qualification";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { ErrorResponse } from "@/http/schemas";
import { CurrentUser } from "@/infra/auth";
import {
  CreateQualificationBody,
  QualificationResponse,
  QualificationsResponse,
  UpdateQualificationBody,
} from "./qualification.contract";
import { QualificationService } from "./qualification.service";

const jsonBody = <T>(schema: T) => ({
  description: "JSON payload.",
  content: { "application/json": { schema } },
});
const response = (item: Qualification) => ({
  id: item.id,
  kind: item.kind,
  title: item.title,
  institution: item.institution,
  country: item.country,
  year: item.year,
  sortOrder: item.sortOrder,
  verifiedAt: item.verifiedAt?.toISOString() ?? null,
});
const idParams = z.object({ id: z.uuid() });
const list = createRoute({
  method: "get",
  path: "/v1/practitioners/me/qualifications",
  tags: ["Qualifications"],
  responses: {
    200: jsonBody(QualificationsResponse),
    401: jsonBody(ErrorResponse),
    404: jsonBody(ErrorResponse),
  },
});
const create = createRoute({
  method: "post",
  path: "/v1/practitioners/me/qualifications",
  tags: ["Qualifications"],
  request: { body: jsonBody(CreateQualificationBody) },
  responses: {
    201: jsonBody(QualificationResponse),
    401: jsonBody(ErrorResponse),
    404: jsonBody(ErrorResponse),
    409: jsonBody(ErrorResponse),
    422: jsonBody(ErrorResponse),
  },
});
const update = createRoute({
  method: "patch",
  path: "/v1/practitioners/me/qualifications/{id}",
  tags: ["Qualifications"],
  request: { params: idParams, body: jsonBody(UpdateQualificationBody) },
  responses: {
    200: jsonBody(QualificationResponse),
    401: jsonBody(ErrorResponse),
    404: jsonBody(ErrorResponse),
    422: jsonBody(ErrorResponse),
  },
});
const remove = createRoute({
  method: "delete",
  path: "/v1/practitioners/me/qualifications/{id}",
  tags: ["Qualifications"],
  request: { params: idParams },
  responses: {
    204: { description: "Removed." },
    401: jsonBody(ErrorResponse),
    404: jsonBody(ErrorResponse),
  },
});

export const registerQualificationRoutes = (
  app: OpenAPIHono<AppEnv>,
  runtime: AppRuntime,
): void => {
  const { runAuth } = makeRun(runtime);
  app.openapi(list, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* QualificationService;
        const data = yield* service.listMine(user.id);
        return c.json(
          {
            data: data.map(response),
            meta: { count: data.length, limit: data.length, nextCursor: null, hasNextPage: false },
          },
          200,
        );
      }),
    ),
  );
  app.openapi(create, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* QualificationService;
        return c.json(response(yield* service.create(user.id, c.req.valid("json"))), 201);
      }),
    ),
  );
  app.openapi(update, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* QualificationService;
        return c.json(
          response(yield* service.update(user.id, c.req.valid("param").id, c.req.valid("json"))),
          200,
        );
      }),
    ),
  );
  app.openapi(remove, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* QualificationService;
        yield* service.remove(user.id, c.req.valid("param").id);
        return c.body(null, 204);
      }),
    ),
  );
};
