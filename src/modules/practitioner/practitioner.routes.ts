import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { Practitioner } from "@/domain/practitioner/practitioner";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { ErrorResponse } from "@/http/schemas";
import { CurrentUser } from "@/infra/auth";
import {
  PractitionerResponse,
  PractitionerVerificationResponse,
  PresignDocumentBody,
  PresignDocumentResponse,
  PublicPractitionerResponse,
  RegisterPractitionerBody,
  SubmitCredentialsBody,
  UpdatePublicProfileBody,
} from "./practitioner.contract";
import { PractitionerService, type PublicPractitionerDetail } from "./practitioner.service";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });

const aggregateEtag = (detail: PublicPractitionerDetail): string => {
  const value = JSON.stringify({
    practitionerUpdatedAt: detail.practitioner.updatedAt,
    languages: detail.languages,
    qualifications: detail.qualifications,
    locations: detail.locations,
    offerings: detail.offerings,
    rating: detail.rating,
    nextAvailableAt: detail.nextAvailableAt,
  });
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `W/"${(hash >>> 0).toString(16)}"`;
};

const publicFields = (p: Practitioner) => ({
  specialty: p.specialty,
  bio: p.bio,
  languagesSpoken: p.languagesSpoken === null ? null : [...p.languagesSpoken],
  yearsExperience: p.yearsExperience,
  consultationFeeXaf: p.consultationFeeXaf,
  consultationTypes: p.consultationTypes === null ? null : [...p.consultationTypes],
  ratingAverage: p.ratingAverage,
  ratingCount: p.ratingCount,
});

const toResponse = (p: Practitioner) => ({
  id: p.id,
  userId: p.userId,
  professionId: p.professionId,
  prefix: p.prefix,
  surname: p.surname,
  givenNames: p.givenNames,
  phone: p.phone,
  dateOfBirth: p.dateOfBirth,
  sex: p.sex,
  location: p.location,
  ...publicFields(p),
  verificationStatus: p.verificationStatus,
});

const toPublicResponse = (detail: PublicPractitionerDetail) => ({
  ...(() => {
    const p = detail.practitioner;
    return {
      id: p.id,
      professionId: p.professionId,
      profession: detail.profession,
      prefix: p.prefix,
      surname: p.surname,
      givenNames: p.givenNames,
      location: p.location,
      ...publicFields(p),
      memberSince: p.createdAt.toISOString(),
      languages: [...detail.languages],
      qualifications: detail.qualifications.map((item) => ({
        ...item,
        verifiedAt: item.verifiedAt?.toISOString() ?? null,
      })),
      locations: detail.locations.map((item) => ({
        id: item.id,
        label: item.label,
        addressLine1: item.addressLine1,
        addressLine2: item.addressLine2,
        city: item.city,
        region: item.region,
        country: item.country,
        latitude: item.latitude,
        longitude: item.longitude,
        consultationTypes: [...item.consultationTypes],
        isPrimary: item.isPrimary,
      })),
      offerings: detail.offerings.map((item) => ({
        id: item.id,
        consultationType: item.consultationType,
        durationMin: item.durationMin,
        priceXaf: item.priceXaf,
        active: item.active,
      })),
      rating: detail.rating,
      verification: detail.verification,
      booking: { ...detail.booking, reasons: [...detail.booking.reasons] },
      canReview: detail.canReview,
      photoUrl: detail.photoUrl,
      nextAvailableAt: detail.nextAvailableAt?.toISOString() ?? null,
    };
  })(),
});

const register = createRoute({
  method: "post",
  path: "/v1/practitioners/register",
  tags: ["Practitioners"],
  summary: "Register the current user as a practitioner",
  description: [
    "Step 1 of the practitioner onboarding flow. Creates the practitioner profile in the",
    "`incomplete` state for the signed-in user. `professionId` is a UUID picked from the",
    "professions catalog, and `role` chooses doctor vs nurse. Consent works like the patient",
    "flow — `acceptTerms` must be `true` and `consentVersion` records what was accepted. Next,",
    "upload documents via `POST /v1/practitioners/me/documents/presign`, then submit credentials",
    "via `POST /v1/practitioners/me/credentials` to move to `pending_verification`.",
  ].join(" "),
  request: { body: jsonBody(RegisterPractitionerBody) },
  responses: {
    201: {
      ...jsonBody(PractitionerResponse),
      description: "Registered — the profile is now in the `incomplete` state.",
    },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    422: { ...jsonBody(ErrorResponse), description: "A field failed validation." },
  },
});

const presign = createRoute({
  method: "post",
  path: "/v1/practitioners/me/documents/presign",
  tags: ["Practitioners"],
  summary: "Get a presigned URL to upload a verification document",
  description: [
    "Step 2 of the onboarding flow — requires an existing (`incomplete`) profile from",
    "`POST /v1/practitioners/register`. Call this ONCE PER document: `kind` is one of",
    "`cmc-certificate`, `nic`, or `profile-photo`. Returns a short-lived `{ url, key }`: `PUT`",
    "the raw file bytes to `url` (no auth header), then keep each returned `key` to pass to",
    "`POST /v1/practitioners/me/credentials` in step 3.",
  ].join(" "),
  request: { body: jsonBody(PresignDocumentBody) },
  responses: {
    200: {
      ...jsonBody(PresignDocumentResponse),
      description: "Presigned upload target for one document.",
    },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    422: { ...jsonBody(ErrorResponse), description: "Unsupported content type." },
  },
});

const submit = createRoute({
  method: "post",
  path: "/v1/practitioners/me/credentials",
  tags: ["Practitioners"],
  summary: "Submit credentials for verification",
  description: [
    "Step 3 of the onboarding flow — requires that you've already presigned and uploaded all",
    "three documents in step 2. Submit `cmcRegistrationNumber` (Cameroon Medical Council) and",
    "`nicNumber` (national ID card) together with the three file `key`s returned by the presign",
    "calls. On success the profile moves to `pending_verification`, and an admin then approves or",
    "rejects it. Returns `409` if the licence number is already registered to another",
    "practitioner or the profile isn't ready to submit.",
  ].join(" "),
  request: { body: jsonBody(SubmitCredentialsBody) },
  responses: {
    200: {
      ...jsonBody(PractitionerResponse),
      description: "Submitted — the profile is now `pending_verification`.",
    },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    409: {
      ...jsonBody(ErrorResponse),
      description:
        "Licence already registered, or the profile isn't in a state that can be submitted.",
    },
    422: {
      ...jsonBody(ErrorResponse),
      description: "A field failed validation or a file failed the security scan.",
    },
  },
});

const getMine = createRoute({
  method: "get",
  path: "/v1/practitioners/me",
  tags: ["Practitioners"],
  summary: "Get the current practitioner profile + verification status",
  description: [
    "The signed-in practitioner's OWN full record, including private fields (phone, dateOfBirth,",
    "sex) and the `verificationStatus` (`incomplete` | `pending_verification` | `verified` |",
    "`rejected`). Use this to drive the onboarding UI — poll it to see when an admin has verified",
    "or rejected the profile. Returns `404` if the signed-in user isn't a practitioner.",
  ].join(" "),
  responses: {
    200: { ...jsonBody(PractitionerResponse), description: "The practitioner's own full record." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    404: { ...jsonBody(ErrorResponse), description: "The signed-in user isn't a practitioner." },
  },
});

const updatePublic = createRoute({
  method: "patch",
  path: "/v1/practitioners/me",
  tags: ["Practitioners"],
  summary: "Update the current practitioner's public/bookable profile",
  description: [
    "Partial update of the PUBLIC, bookable fields only — `prefix`, `location`, `specialty`,",
    "`bio`, `languagesSpoken` (≤10), `yearsExperience` (0–80), and `consultationFeeXaf`. All",
    "fields are optional; send only what you want to change. Identity fields (name, phone, DOB,",
    "sex) are NOT editable here — those live on the base profile. Editing is allowed at any",
    "verification status and does not change it.",
  ].join(" "),
  request: { body: jsonBody(UpdatePublicProfileBody) },
  responses: {
    200: { ...jsonBody(PractitionerResponse), description: "The updated practitioner record." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    404: { ...jsonBody(ErrorResponse), description: "The signed-in user isn't a practitioner." },
    422: { ...jsonBody(ErrorResponse), description: "A field failed validation." },
  },
});

const getPublic = createRoute({
  method: "get",
  path: "/v1/practitioners/{id}",
  tags: ["Practitioners"],
  summary: "Get a verified practitioner's public profile",
  description: [
    "The PUBLIC, bookable view of a practitioner — what patients see when browsing. Returns",
    "VERIFIED practitioners only: an unverified practitioner and an unknown id both return `404`",
    "(treat them the same in the UI — don't reveal that the id exists). Deliberately EXCLUDES",
    "phone, dateOfBirth, sex, and the NIC identifier. The public CMC registration number is",
    "included as verification evidence. `photoUrl` is a presigned download URL",
    "for the profile photo (nullable).",
  ].join(" "),
  request: {
    params: z.object({
      id: z.uuid().openapi({
        description: "Practitioner profile id.",
        example: "3f1a2b6c-8d4e-4f9a-b1c2-0d3e4f5a6b7c",
      }),
    }),
  },
  responses: {
    200: {
      ...jsonBody(PublicPractitionerResponse),
      description: "The verified practitioner's public profile.",
    },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    404: {
      ...jsonBody(ErrorResponse),
      description: "No verified practitioner with that id (unknown or unverified).",
    },
  },
});

const getVerification = createRoute({
  method: "get",
  path: "/v1/practitioners/me/verification",
  tags: ["Practitioners"],
  summary: "Get your verification submission and latest decision",
  responses: {
    200: { ...jsonBody(PractitionerVerificationResponse), description: "Verification status." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    404: { ...jsonBody(ErrorResponse), description: "No practitioner profile." },
  },
});

export const registerPractitionerRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { runAuth } = makeRun(runtime);

  app.openapi(register, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* PractitionerService;
        const body = c.req.valid("json");
        const created = yield* service.register(user.id, body.role, {
          professionId: body.professionId,
          prefix: body.prefix,
          surname: body.surname,
          givenNames: body.givenNames,
          phone: body.phone,
          dateOfBirth: body.dateOfBirth,
          sex: body.sex,
          location: body.location,
          consultationTypes: body.consultationTypes,
          consentVersion: body.consentVersion,
        });
        return c.json(toResponse(created), 201);
      }),
    ),
  );

  app.openapi(presign, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* PractitionerService;
        const body = c.req.valid("json");
        const result = yield* service.presignDocument(user.id, body.kind, body.contentType);
        return c.json(result, 200);
      }),
    ),
  );

  app.openapi(submit, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* PractitionerService;
        const updated = yield* service.submitCredentials(user.id, c.req.valid("json"));
        return c.json(toResponse(updated), 200);
      }),
    ),
  );

  app.openapi(getMine, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* PractitionerService;
        const found = yield* service.getMine(user.id);
        return c.json(toResponse(found), 200);
      }),
    ),
  );

  app.openapi(updatePublic, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* PractitionerService;
        const updated = yield* service.updatePublicProfile(user.id, c.req.valid("json"));
        return c.json(toResponse(updated), 200);
      }),
    ),
  );

  app.openapi(getPublic, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const service = yield* PractitionerService;
        const detail = yield* service.getPublic(c.req.valid("param").id);
        c.header("Cache-Control", "private, max-age=60");
        c.header("ETag", aggregateEtag(detail));
        return c.json(toPublicResponse(detail), 200);
      }),
    ),
  );

  app.openapi(getVerification, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* PractitionerService;
        const value = yield* service.getVerification(user.id);
        return c.json(
          {
            ...value,
            documents: value.documents.map((document) => ({
              ...document,
              uploadedAt: document.uploadedAt.toISOString(),
            })),
            submittedAt: value.submittedAt?.toISOString() ?? null,
            latestDecision:
              value.latestDecision === null
                ? null
                : {
                    ...value.latestDecision,
                    createdAt: value.latestDecision.createdAt.toISOString(),
                  },
          },
          200,
        );
      }),
    ),
  );
};
