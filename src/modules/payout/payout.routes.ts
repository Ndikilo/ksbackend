import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { ErrorResponse } from "@/http/schemas";
import { CurrentUser } from "@/infra/auth";
import {
  CreatePayoutBody,
  PayoutResponse,
  PayoutsResponse,
  UpdatePayoutBody,
} from "./payout.contract";
import { PayoutService } from "./payout.service";
const jsonBody = <T>(schema: T) => ({
  description: "JSON payload.",
  content: { "application/json": { schema } },
});
const params = z.object({ id: z.uuid() });
const list = createRoute({
  method: "get",
  path: "/v1/practitioners/me/payout-methods",
  tags: ["Payouts"],
  responses: {
    200: jsonBody(PayoutsResponse),
    401: jsonBody(ErrorResponse),
    404: jsonBody(ErrorResponse),
  },
});
const create = createRoute({
  method: "post",
  path: "/v1/practitioners/me/payout-methods",
  tags: ["Payouts"],
  request: { body: jsonBody(CreatePayoutBody) },
  responses: {
    201: jsonBody(PayoutResponse),
    401: jsonBody(ErrorResponse),
    404: jsonBody(ErrorResponse),
    409: jsonBody(ErrorResponse),
    422: jsonBody(ErrorResponse),
  },
});
const update = createRoute({
  method: "patch",
  path: "/v1/practitioners/me/payout-methods/{id}",
  tags: ["Payouts"],
  request: { params, body: jsonBody(UpdatePayoutBody) },
  responses: {
    200: jsonBody(PayoutResponse),
    401: jsonBody(ErrorResponse),
    404: jsonBody(ErrorResponse),
    409: jsonBody(ErrorResponse),
    422: jsonBody(ErrorResponse),
  },
});
const remove = createRoute({
  method: "delete",
  path: "/v1/practitioners/me/payout-methods/{id}",
  tags: ["Payouts"],
  request: { params },
  responses: {
    204: { description: "Removed." },
    401: jsonBody(ErrorResponse),
    404: jsonBody(ErrorResponse),
  },
});
export const registerPayoutRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { runAuth } = makeRun(runtime);
  app.openapi(list, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* PayoutService;
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
        const service = yield* PayoutService;
        return c.json(yield* service.create(user.id, c.req.valid("json")), 201);
      }),
    ),
  );
  app.openapi(update, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* PayoutService;
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
        const service = yield* PayoutService;
        yield* service.remove(user.id, c.req.valid("param").id);
        return c.body(null, 204);
      }),
    ),
  );
};
