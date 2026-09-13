import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { Patient } from "@/domain/patient/patient";
import { NotFound } from "@/domain/shared/errors";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { ErrorResponse } from "@/http/schemas";
import { CurrentUser } from "@/infra/auth";
import { CompletePatientProfileBody, PatientProfileResponse } from "./patient.contract";
import { PatientService } from "./patient.service";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });

const toResponse = (patient: Patient) => ({
  id: patient.id,
  userId: patient.userId,
  surname: patient.surname,
  givenNames: patient.givenNames,
  phone: patient.phone,
  dateOfBirth: patient.dateOfBirth,
  sex: patient.sex,
  emergencyContact: patient.emergencyContact,
});

const completeProfile = createRoute({
  method: "post",
  path: "/v1/patients/me/profile",
  tags: ["Patients"],
  summary: "Create or update the current patient's profile",
  description: [
    "Completes (or later updates) the signed-in user's patient profile. In one atomic write it",
    "saves the shared base identity (name, phone, DOB, sex) plus the optional emergency contact,",
    "and grants the user the `patient` role. This is the main onboarding call for a care recipient.",
    "\n\n",
    "It's an idempotent singleton: there's one patient profile per user, so calling it again edits",
    "the same record and always returns `200` (never `201`). `acceptTerms` must be the literal",
    "`true` and `consentVersion` is the terms version being accepted. `emergencyContact` is",
    "optional; omit it to leave any existing contact as-is. If you only need the role and not a",
    "full profile, use `POST /v1/me/roles/patient` instead.",
  ].join(" "),
  request: { body: jsonBody(CompletePatientProfileBody) },
  responses: {
    200: {
      ...jsonBody(PatientProfileResponse),
      description: "The saved patient profile (200 on both first completion and later edits).",
    },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    422: {
      ...jsonBody(ErrorResponse),
      description:
        "A field failed validation (e.g. `acceptTerms` not literally true, bad phone or DOB).",
    },
  },
});

const getProfile = createRoute({
  method: "get",
  path: "/v1/patients/me/profile",
  tags: ["Patients"],
  summary: "Get the current patient's profile",
  description: [
    "Returns the signed-in user's patient profile — the base identity fields plus the emergency",
    "contact. Returns `404` until the profile has been completed via",
    "`POST /v1/patients/me/profile`, so a `404` here is the signal to route the user into patient",
    "onboarding rather than an error to surface.",
  ].join(" "),
  responses: {
    200: { ...jsonBody(PatientProfileResponse), description: "The patient profile." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    404: {
      ...jsonBody(ErrorResponse),
      description: "The user hasn't completed a patient profile yet.",
    },
  },
});

const claimRole = createRoute({
  method: "post",
  path: "/v1/me/roles/patient",
  tags: ["Patients"],
  summary: "Self-grant the patient role (become a care recipient)",
  description: [
    "Grants the signed-in user the `patient` role without completing a full profile — the upgrade",
    "path for someone who already exists in another role (e.g. a doctor who also wants to receive",
    "care). Takes no body and returns `204`. It's non-destructive and idempotent: it never clears",
    "an existing emergency contact or base identity, and calling it when the role is already held",
    "is a no-op. To capture full patient details, use `POST /v1/patients/me/profile` instead.",
  ].join(" "),
  responses: {
    204: { description: "Patient role granted (or already held — no body returned)." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
  },
});

export const registerPatientRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { runAuth } = makeRun(runtime);

  app.openapi(completeProfile, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* PatientService;
        const body = c.req.valid("json");
        const saved = yield* service.completeProfile(user.id, {
          surname: body.surname,
          givenNames: body.givenNames,
          phone: body.phone,
          dateOfBirth: body.dateOfBirth,
          sex: body.sex,
          consentVersion: body.consentVersion,
          emergencyContact: body.emergencyContact,
        });
        return c.json(toResponse(saved), 200);
      }),
    ),
  );

  app.openapi(getProfile, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* PatientService;
        const found = yield* service.getProfile(user.id);
        if (found === undefined) {
          return yield* Effect.fail(new NotFound({ resource: "Patient profile" }));
        }
        return c.json(toResponse(found), 200);
      }),
    ),
  );

  app.openapi(claimRole, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* PatientService;
        yield* service.claimRole(user.id);
        return c.body(null, 204);
      }),
    ),
  );
};
