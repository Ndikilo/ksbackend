import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { Cause, Effect, Exit } from "effect";
import { evlog } from "evlog/hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { ValidationFailed } from "@/domain/shared/errors";
import { type AuthInstance, type AuthUser, parseRoles } from "@/infra/auth";
import { Health } from "@/infra/health";
import { type Locale, negotiateLocale, translate } from "@/infra/i18n";
import { RateLimiter } from "@/infra/rate-limiter";
import { registerAdminRoutes } from "@/modules/admin/admin.routes";
import { registerDependentRoutes } from "@/modules/dependent/dependent.routes";
import { registerInvitationRoutes } from "@/modules/invitation/invitation.routes";
import { registerLocationRoutes } from "@/modules/location/location.routes";
import { registerPatientRoutes } from "@/modules/patient/patient.routes";
import { registerPatientSearchRoutes } from "@/modules/patient/search/search.routes";
import { registerOfferingRoutes } from "@/modules/offering/offering.routes";
import { registerPayoutRoutes } from "@/modules/payout/payout.routes";
import { registerPractitionerRoutes } from "@/modules/practitioner/practitioner.routes";
import { registerPractitionerSearchRoutes } from "@/modules/practitioner/search/search.routes";
import { registerNotificationRoutes } from "@/modules/notification/notification.routes";
import { registerReviewRoutes } from "@/modules/review/review.routes";
import { registerQualificationRoutes } from "@/modules/qualification/qualification.routes";
import { registerReferenceRoutes } from "@/modules/reference/reference.routes";
import { registerAvailabilityRoutes } from "@/modules/availability/availability.routes";
import { registerProfileRoutes } from "@/modules/profile/profile.routes";
import type { AppEnv, AppRuntime } from "./app-env";
import { toErrorResponse } from "./error-mapper";
import { registerMeRoute } from "./me.routes";

let ready = true;

/** Toggle readiness. Used by the graceful-shutdown handler in server.ts. */
export const setReady = (value: boolean): void => {
  ready = value;
};

export type CreateAppOptions = {
  readonly corsOrigins?: ReadonlyArray<string>;
  readonly defaultLocale?: Locale;
};

export const createApp = (
  runtime: AppRuntime,
  auth: AuthInstance,
  options: CreateAppOptions = {},
): OpenAPIHono<AppEnv> => {
  const corsOrigins = [...(options.corsOrigins ?? ["http://localhost:3000"])];
  const defaultLocale: Locale = options.defaultLocale ?? "fr";

  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const issues = result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        }));
        return toErrorResponse(c, Cause.fail(new ValidationFailed({ issues })));
      }
      return undefined;
    },
  });

  // Cross-cutting middleware (order matters): request id → wide-event log →
  // secure headers → CORS → body limit → locale → rate limit → session.
  app.use("*", requestId());
  app.use("*", evlog());
  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: corsOrigins,
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      maxAge: 600,
    }),
  );
  app.use(
    "*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) =>
        c.json(
          {
            error: {
              code: "PAYLOAD_TOO_LARGE",
              message: translate(c.get("locale") ?? defaultLocale, "errors.PAYLOAD_TOO_LARGE"),
              details: [],
            },
            requestId: c.get("requestId"),
          },
          413,
        ),
    }),
  );

  app.use("*", async (c, next) => {
    c.set("locale", negotiateLocale(c.req.header("accept-language"), defaultLocale));
    await next();
  });

  app.use("*", async (c, next) => {
    if (c.req.path === "/livez" || c.req.path === "/readyz") {
      await next();
      return;
    }
    const key = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const exit = await runtime.runPromiseExit(
      Effect.flatMap(RateLimiter, (limiter) => limiter.consume(key)),
    );
    const decision = Exit.isSuccess(exit) ? exit.value : ({ allowed: true } as const);
    if (!decision.allowed) {
      c.header("Retry-After", String(decision.retryAfterSeconds));
      return c.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: translate(c.get("locale"), "errors.RATE_LIMITED"),
            details: [],
          },
          requestId: c.get("requestId"),
        },
        429,
      );
    }
    await next();
    return;
  });

  // Resolve the session → attach the user (roles + locale) to the request.
  app.use("*", async (c, next) => {
    let user: AuthUser | null = null;
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session?.user) {
      const found = session.user;
      user = {
        id: found.id,
        email: found.email,
        name: found.name,
        roles: parseRoles(found.role),
        locale: found.locale === "en" || found.locale === "fr" ? found.locale : defaultLocale,
      };
    }
    c.set("user", user);
    await next();
  });

  // better-auth owns everything under /api/auth/* (mounted OUTSIDE Effect).
  app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  app.get("/livez", (c) => c.json({ status: "ok" } as const));
  app.get("/readyz", async (c) => {
    if (!ready) {
      return c.json({ status: "unavailable" } as const, 503);
    }
    const exit = await runtime.runPromiseExit(Effect.flatMap(Health, (health) => health.ready));
    const ok = Exit.isSuccess(exit) && exit.value;
    return ok ? c.json({ status: "ok" } as const) : c.json({ status: "unavailable" } as const, 503);
  });

  registerMeRoute(app, runtime);
  registerProfileRoutes(app, runtime);
  registerNotificationRoutes(app, runtime);
  registerPatientRoutes(app, runtime);
  registerPatientSearchRoutes(app, runtime);
  registerPractitionerRoutes(app, runtime);
  registerPractitionerSearchRoutes(app, runtime);
  registerReviewRoutes(app, runtime);
  registerAvailabilityRoutes(app, runtime);
  registerReferenceRoutes(app, runtime);
  registerQualificationRoutes(app, runtime);
  registerLocationRoutes(app, runtime);
  registerOfferingRoutes(app, runtime);
  registerPayoutRoutes(app, runtime);
  registerAdminRoutes(app, runtime);
  registerDependentRoutes(app, runtime);
  registerInvitationRoutes(app, runtime);

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "KanaSanté API",
      version: "0.0.0",
      description: [
        "REST API for KanaSanté — diaspora members book and pay for healthcare on behalf of",
        "dependents back home. This reference is generated from the same Zod schemas the",
        "handlers validate against, so it never drifts from the implementation.",
        "",
        "## Conventions",
        "",
        "- **Auth** — Authentication is handled by better-auth under `/api/auth/*` (documented",
        "  separately by better-auth). Every `/v1/*` route needs a valid session cookie; without",
        "  one you get `401 UNAUTHORIZED`. A few reads are role/scope-gated (`403`).",
        "- **Errors** — Uniform envelope on every non-2xx:",
        "  `{ error: { code, message, details }, requestId }`. `code` is a stable machine string",
        "  (e.g. `VALIDATION_FAILED`, `NOT_FOUND`, `CONFLICT`); `message` is localized (en/fr).",
        "- **Single resource** — returned as a bare object. **Lists** — always the cursor-paginated",
        "  envelope `{ data, meta }` where `meta = { count, limit, nextCursor, hasNextPage }`.",
        "  Page forward by passing `?cursor=<meta.nextCursor>` until `hasNextPage` is false.",
        "- **File uploads** — two steps: `POST …/presign` to get a short-lived `{ url, key }`, then",
        "  `PUT` the bytes straight to `url`, then send the `key` back on the relevant write.",
        "- **Formats** — phone numbers are E.164 (`+2376…`); dates (DOB) are `YYYY-MM-DD`; ids are UUID.",
        "",
        "## Typical flows (call order)",
        "",
        "**Any user onboarding** — `POST /api/auth/sign-up/email` → verify the emailed OTP →",
        "`POST /api/auth/sign-in/email`. Then `GET /v1/me` for identity + roles.",
        "",
        "**Patient / caregiver** — complete identity via `POST /v1/patients/me/profile` (this also",
        "grants the `patient` role and stores the emergency contact). Manage care recipients under",
        "**Dependents** below. Any user can also self-serve the role with `POST /v1/me/roles/patient`.",
        "",
        "**Practitioner (doctor/nurse)** — `POST /v1/practitioners/register` → upload each document",
        "with `POST /v1/practitioners/me/documents/presign` (×3: CMC certificate, NIC, photo) →",
        "`POST /v1/practitioners/me/credentials` with the returned keys (moves to",
        "`pending_verification`) → an admin approves/rejects. Edit the public profile anytime with",
        "`PATCH /v1/practitioners/me`; the bookable public view is `GET /v1/practitioners/{id}`.",
        "",
        "**Managed dependents** (no login of their own) — full CRUD under `/v1/dependents`. A",
        "dependent may have several caregivers; `DELETE` unlinks the caller and only soft-deletes",
        "the person when the last caregiver leaves.",
        "",
        "**Linked dependents** (an existing account-holder) — `POST /v1/dependents/invitations`",
        "emails them a token → they `POST /v1/invitations/{token}/accept` (or `/decline`). Either",
        "party revokes with `DELETE /v1/dependents/links/{id}`. Check whether an email already has",
        "an account with `GET /v1/users/search` before inviting.",
      ].join("\n"),
    },
    tags: [
      { name: "Account", description: "Identity and roles for the signed-in user." },
      {
        name: "Profile",
        description:
          "The shared base profile (name, phone, DOB, avatar) that every role reads from, plus notification preferences.",
      },
      {
        name: "Patients",
        description:
          "Patient profile (identity + emergency contact) and the self-serve patient-role grant.",
      },
      {
        name: "Practitioners",
        description:
          "Doctor/nurse registration, credential upload & submission, editable public profile, and the public bookable view.",
      },
      {
        name: "Search",
        description:
          "Discovery: search verified, active practitioners as result cards with combinable filters and sorting.",
      },
      {
        name: "Reviews",
        description:
          "Patient ratings + comments for practitioners; drives the average rating shown on discovery cards.",
      },
      {
        name: "Availability",
        description:
          "Practitioners publish bookable time slots; drives the next-available slot shown on discovery cards.",
      },
      { name: "Reference", description: "Active profession and ISO language catalogs." },
      { name: "Qualifications", description: "Practitioner qualifications and certifications." },
      { name: "Locations", description: "Structured practitioner appointment locations." },
      {
        name: "Offerings",
        description: "Consultation type, duration, pricing, and earnings terms.",
      },
      { name: "Payouts", description: "Private, encrypted practitioner payout methods." },
      {
        name: "Admin",
        description:
          "Verification review queue. Scope-gated: requires an admin with super_admin or verification_reviewer scope.",
      },
      {
        name: "Dependents",
        description:
          "Care recipients — both managed dependents (no login) and the invitation flow for linking existing account-holders.",
      },
    ],
  });
  app.get("/docs", Scalar({ url: "/openapi.json" }));

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: translate(c.get("locale") ?? defaultLocale, "errors.ROUTE_NOT_FOUND"),
          details: [],
        },
        requestId: c.get("requestId"),
      },
      404,
    ),
  );
  app.onError((error, c) => toErrorResponse(c, Cause.fail(error)));

  return app;
};
