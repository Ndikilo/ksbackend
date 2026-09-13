import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { Dependent } from "@/domain/dependent/dependent";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { CursorQuery, ErrorResponse } from "@/http/schemas";
import { CurrentUser } from "@/infra/auth";
import {
  CreateDependentBody,
  DependentResponse,
  DependentsPage,
  UpdateDependentBody,
} from "./dependent.contract";
import { DependentService } from "./dependent.service";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const IdParam = z.object({
  id: z.uuid().openapi({
    description: "The dependent person's id (from a create or list response).",
    example: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  }),
});

const toResponse = (d: Dependent) => ({
  id: d.id,
  surname: d.surname,
  givenNames: d.givenNames,
  dateOfBirth: d.dateOfBirth,
  sex: d.sex,
  relationship: d.relationship,
  phone: d.phone,
  location: d.location,
});

const create = createRoute({
  method: "post",
  path: "/v1/dependents",
  tags: ["Dependents"],
  summary: "Add a dependent",
  description: [
    "Create a managed dependent — a care recipient who has NO login of their own (a child, an",
    "elderly parent). The caller becomes the first caregiver, and the `relationship` you send is",
    "recorded on that caregiver link. Dependents are many-to-many: another caregiver can later be",
    "linked to the same person with their own relationship. To link someone who DOES have an",
    "account instead, use `POST /v1/dependents/invitations`.",
  ].join(" "),
  request: { body: jsonBody(CreateDependentBody) },
  responses: {
    201: {
      ...jsonBody(DependentResponse),
      description: "The newly created dependent, as seen by this caregiver.",
    },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    422: { ...jsonBody(ErrorResponse), description: "A field failed validation." },
  },
});

const list = createRoute({
  method: "get",
  path: "/v1/dependents",
  tags: ["Dependents"],
  summary: "List the current user's dependents",
  description: [
    "Cursor-paginated list of every dependent the caller is a caregiver for. Each entry's",
    "`relationship` reflects the caller's own link. Pass `meta.nextCursor` back as `cursor` to",
    "fetch the next page. Only managed dependents the caller is linked to appear here.",
  ].join(" "),
  request: { query: CursorQuery },
  responses: {
    200: { ...jsonBody(DependentsPage), description: "A page of the caller's dependents." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
  },
});

const getOne = createRoute({
  method: "get",
  path: "/v1/dependents/{id}",
  tags: ["Dependents"],
  summary: "Get a dependent",
  description: [
    "Fetch a single dependent by id, with the `relationship` from the caller's own caregiver link.",
    "Returns `404` if the caller is not a caregiver of this dependent — non-caregivers get `404`,",
    "not `403`, so the existence of other people's dependents is never leaked.",
  ].join(" "),
  request: { params: IdParam },
  responses: {
    200: {
      ...jsonBody(DependentResponse),
      description: "The dependent, as seen by this caregiver.",
    },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    404: {
      ...jsonBody(ErrorResponse),
      description: "No such dependent, or the caller is not a caregiver.",
    },
  },
});

const update = createRoute({
  method: "patch",
  path: "/v1/dependents/{id}",
  tags: ["Dependents"],
  summary: "Update a dependent",
  description: [
    "Partial update — send only the fields you want to change. Person fields (name, DOB, sex,",
    "phone, location) update the shared dependent record and are therefore visible to every",
    "caregiver. `relationship` is the exception: it updates ONLY the caller's own link, leaving",
    "other caregivers' relationships untouched. Non-caregivers get `404`.",
  ].join(" "),
  request: { params: IdParam, body: jsonBody(UpdateDependentBody) },
  responses: {
    200: {
      ...jsonBody(DependentResponse),
      description: "The updated dependent, as seen by this caregiver.",
    },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    404: {
      ...jsonBody(ErrorResponse),
      description: "No such dependent, or the caller is not a caregiver.",
    },
  },
});

const remove = createRoute({
  method: "delete",
  path: "/v1/dependents/{id}",
  tags: ["Dependents"],
  summary: "Remove a dependent",
  description: [
    "Unlink the caller from this dependent. Because dependents are many-to-many, this only removes",
    "the caller's own caregiver link — the dependent person is SOFT-DELETED only when the LAST",
    "remaining caregiver leaves. Other caregivers keep their access. Non-caregivers get `404`.",
  ].join(" "),
  request: { params: IdParam },
  responses: {
    204: { description: "The caller's link was removed (no body)." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    404: {
      ...jsonBody(ErrorResponse),
      description: "No such dependent, or the caller is not a caregiver.",
    },
  },
});

export const registerDependentRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { runAuth } = makeRun(runtime);

  app.openapi(create, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* DependentService;
        const created = yield* service.create(user.id, c.req.valid("json"));
        return c.json(toResponse(created), 201);
      }),
    ),
  );

  app.openapi(list, (c) => {
    const { limit, cursor } = c.req.valid("query");
    return runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* DependentService;
        const page = yield* service.list(user.id, limit, cursor);
        return c.json({ data: page.data.map(toResponse), meta: page.meta }, 200);
      }),
    );
  });

  app.openapi(getOne, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* DependentService;
        const found = yield* service.get(user.id, c.req.valid("param").id);
        return c.json(toResponse(found), 200);
      }),
    ),
  );

  app.openapi(update, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* DependentService;
        const updated = yield* service.update(
          user.id,
          c.req.valid("param").id,
          c.req.valid("json"),
        );
        return c.json(toResponse(updated), 200);
      }),
    ),
  );

  app.openapi(remove, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* DependentService;
        yield* service.remove(user.id, c.req.valid("param").id);
        return c.body(null, 204);
      }),
    ),
  );
};
