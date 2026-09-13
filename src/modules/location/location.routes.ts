import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { ErrorResponse } from "@/http/schemas";
import { CurrentUser } from "@/infra/auth";
import {
  CreateLocationBody,
  LocationResponse,
  LocationsResponse,
  UpdateLocationBody,
} from "./location.contract";
import { LocationService } from "./location.service";

const jsonBody = <T>(schema: T) => ({
  description: "JSON payload.",
  content: { "application/json": { schema } },
});
const params = z.object({ id: z.uuid() });
const response = (item: {
  readonly id: string;
  readonly label: string;
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string;
  readonly region: string;
  readonly country: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly consultationTypes: ReadonlyArray<"in_person" | "video" | "home_visit">;
  readonly isPrimary: boolean;
}) => ({ ...item, consultationTypes: [...item.consultationTypes] });
const list = createRoute({
  method: "get",
  path: "/v1/practitioners/me/locations",
  tags: ["Locations"],
  responses: {
    200: jsonBody(LocationsResponse),
    401: jsonBody(ErrorResponse),
    404: jsonBody(ErrorResponse),
    409: jsonBody(ErrorResponse),
  },
});
const create = createRoute({
  method: "post",
  path: "/v1/practitioners/me/locations",
  tags: ["Locations"],
  request: { body: jsonBody(CreateLocationBody) },
  responses: {
    201: jsonBody(LocationResponse),
    401: jsonBody(ErrorResponse),
    404: jsonBody(ErrorResponse),
    409: jsonBody(ErrorResponse),
    422: jsonBody(ErrorResponse),
  },
});
const update = createRoute({
  method: "patch",
  path: "/v1/practitioners/me/locations/{id}",
  tags: ["Locations"],
  request: { params, body: jsonBody(UpdateLocationBody) },
  responses: {
    200: jsonBody(LocationResponse),
    401: jsonBody(ErrorResponse),
    404: jsonBody(ErrorResponse),
    422: jsonBody(ErrorResponse),
  },
});
const remove = createRoute({
  method: "delete",
  path: "/v1/practitioners/me/locations/{id}",
  tags: ["Locations"],
  request: { params },
  responses: {
    204: { description: "Removed." },
    401: jsonBody(ErrorResponse),
    404: jsonBody(ErrorResponse),
  },
});
export const registerLocationRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { runAuth } = makeRun(runtime);
  app.openapi(list, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* LocationService;
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
        const service = yield* LocationService;
        return c.json(response(yield* service.create(user.id, c.req.valid("json"))), 201);
      }),
    ),
  );
  app.openapi(update, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* LocationService;
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
        const service = yield* LocationService;
        yield* service.remove(user.id, c.req.valid("param").id);
        return c.body(null, 204);
      }),
    ),
  );
};
