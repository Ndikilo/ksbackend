import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { AvailabilitySlot } from "@/domain/availability/availability";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { CursorQuery, ErrorResponse } from "@/http/schemas";
import { CurrentUser } from "@/infra/auth";
import {
  AvailabilityDaysResponse,
  AvailabilityExceptionBody,
  AvailabilityExceptionResponse,
  AvailabilityRulesResponse,
  CreateSlotBody,
  PublicSlotsResponse,
  ReplaceAvailabilityRulesBody,
  SlotResponse,
  SlotsPage,
} from "./availability.contract";
import { AvailabilityService } from "./availability.service";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const toWireTime = (time: string | null): string | null =>
  time === null ? null : time.slice(0, 5);

const toResponse = (s: AvailabilitySlot) => ({
  id: s.id,
  startsAt: s.startsAt.toISOString(),
  endsAt: s.endsAt.toISOString(),
  consultationTypes: [...s.consultationTypes],
  locationId: s.locationId,
  status: s.status,
});

const toRuleResponse = (rule: {
  readonly id: string;
  readonly weekday: number;
  readonly startTime: string;
  readonly endTime: string;
  readonly slotDurationMin: number;
  readonly consultationTypes: ReadonlyArray<"in_person" | "video" | "home_visit">;
  readonly locationId: string | null;
  readonly timezone: "Africa/Douala";
  readonly validFrom: string | null;
  readonly validTo: string | null;
}) => ({
  ...rule,
  startTime: toWireTime(rule.startTime) ?? rule.startTime,
  endTime: toWireTime(rule.endTime) ?? rule.endTime,
  consultationTypes: [...rule.consultationTypes],
});

const create = createRoute({
  method: "post",
  path: "/v1/practitioners/me/availability",
  tags: ["Availability"],
  summary: "Publish an availability slot",
  description: [
    "The signed-in practitioner publishes a bookable time slot. Requires the `doctor`/`nurse` role",
    "(`403` otherwise) and an existing practitioner profile (`404`). `startsAt` must be in the",
    "future and `endsAt` after it (`422` otherwise); a slot overlapping an existing active one is",
    "`409`. Patients reserving slots is a later story — this only publishes availability.",
  ].join(" "),
  request: { body: jsonBody(CreateSlotBody) },
  responses: {
    201: { ...jsonBody(SlotResponse), description: "The published slot." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: { ...jsonBody(ErrorResponse), description: "Caller is not a practitioner." },
    404: { ...jsonBody(ErrorResponse), description: "The signed-in user isn't a practitioner." },
    409: { ...jsonBody(ErrorResponse), description: "The slot overlaps an existing one." },
    422: { ...jsonBody(ErrorResponse), description: "Invalid times (past start, or end ≤ start)." },
  },
});

const list = createRoute({
  method: "get",
  path: "/v1/practitioners/me/availability",
  tags: ["Availability"],
  summary: "List your published slots",
  description:
    "A cursor-paginated list of the signed-in practitioner's active (non-cancelled) slots.",
  request: { query: CursorQuery },
  responses: {
    200: { ...jsonBody(SlotsPage), description: "A page of your slots." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: { ...jsonBody(ErrorResponse), description: "Caller is not a practitioner." },
    404: { ...jsonBody(ErrorResponse), description: "The signed-in user isn't a practitioner." },
  },
});

const remove = createRoute({
  method: "delete",
  path: "/v1/practitioners/me/availability/{slotId}",
  tags: ["Availability"],
  summary: "Cancel one of your slots",
  description: "Cancels (soft-deletes) a slot you own. `404` if it doesn't exist or isn't yours.",
  request: {
    params: z.object({
      slotId: z.uuid().openapi({ description: "The slot id to cancel." }),
    }),
  },
  responses: {
    204: { description: "The slot was cancelled (no body)." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: { ...jsonBody(ErrorResponse), description: "Caller is not a practitioner." },
    404: { ...jsonBody(ErrorResponse), description: "No such slot owned by the caller." },
  },
});

const rules = createRoute({
  method: "get",
  path: "/v1/practitioners/me/availability/rules",
  tags: ["Availability"],
  responses: {
    200: { ...jsonBody(AvailabilityRulesResponse), description: "Weekly schedule." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: { ...jsonBody(ErrorResponse), description: "Not a practitioner." },
    404: { ...jsonBody(ErrorResponse), description: "No practitioner profile." },
  },
});
const replaceRules = createRoute({
  method: "put",
  path: "/v1/practitioners/me/availability/rules",
  tags: ["Availability"],
  request: { body: jsonBody(ReplaceAvailabilityRulesBody) },
  responses: {
    200: { ...jsonBody(AvailabilityRulesResponse), description: "Replaced schedule." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: { ...jsonBody(ErrorResponse), description: "Not a practitioner." },
    404: { ...jsonBody(ErrorResponse), description: "No practitioner profile." },
    422: { ...jsonBody(ErrorResponse), description: "Invalid schedule." },
  },
});
const createException = createRoute({
  method: "post",
  path: "/v1/practitioners/me/availability/exceptions",
  tags: ["Availability"],
  request: { body: jsonBody(AvailabilityExceptionBody) },
  responses: {
    201: { ...jsonBody(AvailabilityExceptionResponse), description: "Created exception." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: { ...jsonBody(ErrorResponse), description: "Not a practitioner." },
    404: { ...jsonBody(ErrorResponse), description: "No practitioner profile." },
    409: { ...jsonBody(ErrorResponse), description: "The client-supplied id is already in use." },
    422: { ...jsonBody(ErrorResponse), description: "Invalid exception." },
  },
});
const deleteException = createRoute({
  method: "delete",
  path: "/v1/practitioners/me/availability/exceptions/{id}",
  tags: ["Availability"],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    204: { description: "Removed exception." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: { ...jsonBody(ErrorResponse), description: "Not a practitioner." },
    404: { ...jsonBody(ErrorResponse), description: "Unknown exception." },
  },
});
const publicSlots = createRoute({
  method: "get",
  path: "/v1/practitioners/{id}/availability",
  tags: ["Availability"],
  request: {
    params: z.object({ id: z.uuid() }),
    query: z.object({ from: z.iso.datetime().optional(), to: z.iso.datetime().optional() }),
  },
  responses: {
    200: { ...jsonBody(PublicSlotsResponse), description: "Expanded open slots." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    404: { ...jsonBody(ErrorResponse), description: "Unknown or unverified practitioner." },
    422: { ...jsonBody(ErrorResponse), description: "Invalid range." },
  },
});
const publicDays = createRoute({
  method: "get",
  path: "/v1/practitioners/{id}/availability/days",
  tags: ["Availability"],
  request: {
    params: z.object({ id: z.uuid() }),
    query: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }),
  },
  responses: {
    200: { ...jsonBody(AvailabilityDaysResponse), description: "Days with availability." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    404: { ...jsonBody(ErrorResponse), description: "Unknown or unverified practitioner." },
  },
});

export const registerAvailabilityRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { runAuth } = makeRun(runtime);

  app.openapi(create, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AvailabilityService;
        const body = c.req.valid("json");
        const slot = yield* service.createSlot(user.id, {
          startsAt: new Date(Date.parse(body.startsAt)),
          endsAt: new Date(Date.parse(body.endsAt)),
          id: body.id,
          consultationTypes: body.consultationTypes,
          locationId: body.locationId,
        });
        return c.json(toResponse(slot), 201);
      }),
    ),
  );

  app.openapi(list, (c) => {
    const { limit, cursor } = c.req.valid("query");
    return runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AvailabilityService;
        const page = yield* service.listMine(user.id, limit, cursor);
        return c.json({ data: page.data.map(toResponse), meta: page.meta }, 200);
      }),
    );
  });

  app.openapi(remove, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AvailabilityService;
        yield* service.deleteSlot(user.id, c.req.valid("param").slotId);
        return c.body(null, 204);
      }),
    ),
  );

  app.openapi(rules, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AvailabilityService;
        const data = yield* service.listRules(user.id);
        return c.json(
          {
            data: data.map(toRuleResponse),
            meta: { count: data.length, limit: data.length, nextCursor: null, hasNextPage: false },
          },
          200,
        );
      }),
    ),
  );
  app.openapi(replaceRules, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AvailabilityService;
        const data = yield* service.replaceRules(user.id, c.req.valid("json").rules);
        return c.json(
          {
            data: data.map(toRuleResponse),
            meta: { count: data.length, limit: data.length, nextCursor: null, hasNextPage: false },
          },
          200,
        );
      }),
    ),
  );
  app.openapi(createException, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AvailabilityService;
        const created = yield* service.createException(user.id, c.req.valid("json"));
        return c.json(
          {
            ...created,
            startTime: toWireTime(created.startTime),
            endTime: toWireTime(created.endTime),
            consultationTypes:
              created.consultationTypes === null ? null : [...created.consultationTypes],
          },
          201,
        );
      }),
    ),
  );
  app.openapi(deleteException, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AvailabilityService;
        yield* service.deleteException(user.id, c.req.valid("param").id);
        return c.body(null, 204);
      }),
    ),
  );
  app.openapi(publicSlots, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const service = yield* AvailabilityService;
        const query = c.req.valid("query");
        const { data, from, to } = yield* service.publicAvailability(
          c.req.valid("param").id,
          query.from === undefined ? undefined : new Date(Date.parse(query.from)),
          query.to === undefined ? undefined : new Date(Date.parse(query.to)),
        );
        return c.json(
          {
            data: data.map((slot) => ({
              ...slot,
              startsAt: slot.startsAt.toISOString(),
              endsAt: slot.endsAt.toISOString(),
              consultationTypes: [...slot.consultationTypes],
            })),
            meta: { count: data.length, from: from.toISOString(), to: to.toISOString() },
          },
          200,
        );
      }),
    ),
  );
  app.openapi(publicDays, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const service = yield* AvailabilityService;
        const month = c.req.valid("query").month;
        const data = yield* service.availabilityDays(c.req.valid("param").id, month);
        return c.json({ data: [...data], meta: { count: data.length, month } }, 200);
      }),
    ),
  );
};
