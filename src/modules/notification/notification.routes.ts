import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { NotificationPreference } from "@/domain/notification/notification";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { ErrorResponse } from "@/http/schemas";
import { CurrentUser } from "@/infra/auth";
import {
  NotificationPreferencesResponse,
  UpdateNotificationPreferencesBody,
} from "./notification.contract";
import { NotificationService } from "./notification.service";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });

const toResponse = (preferences: ReadonlyArray<NotificationPreference>) => ({
  preferences: preferences.map((p) => ({
    category: p.category,
    email: p.email,
    sms: p.sms,
    push: p.push,
  })),
});

const get = createRoute({
  method: "get",
  path: "/v1/me/notifications",
  tags: ["Profile"],
  summary: "Get the current user's notification preferences (all categories)",
  description: [
    "Returns the complete per-category × per-channel preference matrix for the signed-in user.",
    "Every category (appointments, verification, security, account) is always present in the",
    "response; any the user has never explicitly set come back filled with server defaults, so",
    "the client can render the full settings screen without merging in anything of its own.",
    "Send changes back with `PATCH /v1/me/notifications`.",
  ].join(" "),
  responses: {
    200: {
      ...jsonBody(NotificationPreferencesResponse),
      description: "The full preference matrix — one row per category, defaults filled in.",
    },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
  },
});

const update = createRoute({
  method: "patch",
  path: "/v1/me/notifications",
  tags: ["Profile"],
  summary: "Update notification preferences for one or more categories",
  description: [
    "Upserts between 1 and 20 category rows. Send only the categories you're changing — each",
    "row overwrites the per-channel flags (email/sms/push) for its category; categories you don't",
    "include are left exactly as they were. Read the current state first with",
    "`GET /v1/me/notifications`. The response is the full updated matrix (all categories), not",
    "just the rows you sent, so the client can re-render straight from it.",
  ].join(" "),
  request: { body: jsonBody(UpdateNotificationPreferencesBody) },
  responses: {
    200: {
      ...jsonBody(NotificationPreferencesResponse),
      description:
        "The full updated matrix, reflecting your changes plus every untouched category.",
    },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    422: {
      ...jsonBody(ErrorResponse),
      description: "Empty/oversized list (must be 1–20 rows) or an unknown category.",
    },
  },
});

export const registerNotificationRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { runAuth } = makeRun(runtime);

  app.openapi(get, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* NotificationService;
        return c.json(toResponse(yield* service.get(user.id)), 200);
      }),
    ),
  );

  app.openapi(update, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* NotificationService;
        const updated = yield* service.update(user.id, c.req.valid("json").preferences);
        return c.json(toResponse(updated), 200);
      }),
    ),
  );
};
