import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { ErrorResponse } from "@/http/schemas";
import { CurrentUser } from "@/infra/auth";
import {
  EarningsTermsResponse,
  CreateOfferingBody,
  OfferingResponse,
  OfferingsResponse,
  UpdateOfferingBody,
} from "./offering.contract";
import { OfferingService } from "./offering.service";
const jsonBody = <T>(schema: T) => ({
  description: "JSON payload.",
  content: { "application/json": { schema } },
});
const params = z.object({ id: z.uuid() });
const list = createRoute({
  method: "get",
  path: "/v1/practitioners/me/offerings",
  tags: ["Offerings"],
  responses: {
    200: jsonBody(OfferingsResponse),
    401: jsonBody(ErrorResponse),
    404: jsonBody(ErrorResponse),
  },
});
const create = createRoute({
  method: "post",
  path: "/v1/practitioners/me/offerings",
  tags: ["Offerings"],
  request: { body: jsonBody(CreateOfferingBody) },
  responses: {
    201: jsonBody(OfferingResponse),
    401: jsonBody(ErrorResponse),
    404: jsonBody(ErrorResponse),
    409: jsonBody(ErrorResponse),
    422: jsonBody(ErrorResponse),
  },
});
const update = createRoute({
  method: "patch",
  path: "/v1/practitioners/me/offerings/{id}",
  tags: ["Offerings"],
  request: { params, body: jsonBody(UpdateOfferingBody) },
  responses: {
    200: jsonBody(OfferingResponse),
    401: jsonBody(ErrorResponse),
    404: jsonBody(ErrorResponse),
    409: jsonBody(ErrorResponse),
    422: jsonBody(ErrorResponse),
  },
});
const remove = createRoute({
  method: "delete",
  path: "/v1/practitioners/me/offerings/{id}",
  tags: ["Offerings"],
  request: { params },
  responses: {
    204: { description: "Removed." },
    401: jsonBody(ErrorResponse),
    404: jsonBody(ErrorResponse),
  },
});
const terms = createRoute({
  method: "get",
  path: "/v1/practitioners/me/earnings-terms",
  tags: ["Offerings"],
  responses: { 200: jsonBody(EarningsTermsResponse), 401: jsonBody(ErrorResponse) },
});
export const registerOfferingRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { runAuth } = makeRun(runtime);
  app.openapi(list, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* OfferingService;
        const data = yield* service.listMine(user.id);
        return c.json(
          {
            data: [...data],
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
        const service = yield* OfferingService;
        return c.json(yield* service.create(user.id, c.req.valid("json")), 201);
      }),
    ),
  );
  app.openapi(update, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* OfferingService;
        return c.json(
          yield* service.update(user.id, c.req.valid("param").id, c.req.valid("json")),
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
        const service = yield* OfferingService;
        yield* service.remove(user.id, c.req.valid("param").id);
        return c.body(null, 204);
      }),
    ),
  );
  app.openapi(terms, (c) =>
    runAuth(
      c,
      Effect.flatMap(OfferingService, (service) =>
        service.earningsTerms.pipe(Effect.map((value) => c.json(value, 200))),
      ),
    ),
  );
};
