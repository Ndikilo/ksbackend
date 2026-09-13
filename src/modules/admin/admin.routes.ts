import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { Practitioner } from "@/domain/practitioner/practitioner";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { CursorQuery, ErrorResponse } from "@/http/schemas";
import { AdminService } from "./admin.service";
import {
  PendingVerificationsResponse,
  RejectBody,
  VerificationDetailResponse,
  VerificationPractitionerResponse,
} from "./admin.contract";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });
const IdParam = z.object({
  id: z.uuid().openapi({
    description: "The practitioner-profile UUID (from the pending-verifications list).",
    example: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  }),
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
  specialty: p.specialty,
  bio: p.bio,
  languagesSpoken: p.languagesSpoken === null ? null : [...p.languagesSpoken],
  yearsExperience: p.yearsExperience,
  consultationFeeXaf: p.consultationFeeXaf,
  consultationTypes: p.consultationTypes === null ? null : [...p.consultationTypes],
  ratingAverage: p.ratingAverage,
  ratingCount: p.ratingCount,
  verificationStatus: p.verificationStatus,
});

const list = createRoute({
  method: "get",
  path: "/v1/admin/verifications",
  tags: ["Admin"],
  summary: "List practitioners pending verification",
  description: [
    "The reviewer's work queue: a cursor-paginated list of practitioners whose",
    "`verificationStatus` is `pending_verification`, awaiting a manual credential review. SCOPE-",
    "GATED — the caller must be an admin whose scope is `super_admin` or `verification_reviewer`;",
    "any other user gets `403`. Pass `meta.nextCursor` back as `cursor` for the next page; open a",
    "row with `GET /v1/admin/verifications/{id}` to see the full submission.",
  ].join(" "),
  request: { query: CursorQuery },
  responses: {
    200: {
      ...jsonBody(PendingVerificationsResponse),
      description: "A page of practitioners awaiting verification.",
    },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: {
      ...jsonBody(ErrorResponse),
      description: "Caller lacks the super_admin / verification_reviewer scope.",
    },
  },
});

const detail = createRoute({
  method: "get",
  path: "/v1/admin/verifications/{id}",
  tags: ["Admin"],
  summary: "Review a practitioner's submitted credentials",
  description: [
    "The full submission for one practitioner: their profile record plus the sensitive fields a",
    "reviewer needs — the DECRYPTED CMC registration number and national identity number — and",
    "presigned URLs to the uploaded certificate, ID, and photo (each nullable, each short-lived).",
    "`{id}` is the practitioner-profile UUID. SCOPE-GATED (`super_admin` / `verification_reviewer`;",
    "else `403`). Reviewed here, then resolved via the approve or reject endpoints.",
  ].join(" "),
  request: { params: IdParam },
  responses: {
    200: {
      ...jsonBody(VerificationDetailResponse),
      description: "The full submission, with decrypted IDs and presigned document URLs.",
    },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: {
      ...jsonBody(ErrorResponse),
      description: "Caller lacks the super_admin / verification_reviewer scope.",
    },
    404: { ...jsonBody(ErrorResponse), description: "No practitioner submission with this id." },
  },
});

const approve = createRoute({
  method: "post",
  path: "/v1/admin/verifications/{id}/approve",
  tags: ["Admin"],
  summary: "Approve a practitioner",
  description: [
    "Approve a reviewed submission: marks the practitioner `verified`, emails them the good news,",
    "and writes an audit row recording who approved and when. SCOPE-GATED (`super_admin` /",
    "`verification_reviewer`; else `403`). Only works from a reviewable state — approving a",
    "practitioner who is already verified or not pending returns `409`.",
  ].join(" "),
  request: { params: IdParam },
  responses: {
    200: {
      ...jsonBody(VerificationPractitionerResponse),
      description: "The practitioner record, now verified.",
    },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: {
      ...jsonBody(ErrorResponse),
      description: "Caller lacks the super_admin / verification_reviewer scope.",
    },
    404: { ...jsonBody(ErrorResponse), description: "No practitioner submission with this id." },
    409: {
      ...jsonBody(ErrorResponse),
      description: "The practitioner is not in a reviewable state.",
    },
  },
});

const reject = createRoute({
  method: "post",
  path: "/v1/admin/verifications/{id}/reject",
  tags: ["Admin"],
  summary: "Reject a practitioner with a reason",
  description: [
    "Reject a reviewed submission with a required `reason` (3–500 chars), which is emailed to the",
    "practitioner so they can correct and resubmit. SCOPE-GATED (`super_admin` /",
    "`verification_reviewer`; else `403`). Only works from a reviewable state (`409` otherwise), and",
    "a missing or too-short/long reason returns `422`.",
  ].join(" "),
  request: { params: IdParam, body: jsonBody(RejectBody) },
  responses: {
    200: {
      ...jsonBody(VerificationPractitionerResponse),
      description: "The practitioner record, now rejected.",
    },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: {
      ...jsonBody(ErrorResponse),
      description: "Caller lacks the super_admin / verification_reviewer scope.",
    },
    404: { ...jsonBody(ErrorResponse), description: "No practitioner submission with this id." },
    409: {
      ...jsonBody(ErrorResponse),
      description: "The practitioner is not in a reviewable state.",
    },
    422: {
      ...jsonBody(ErrorResponse),
      description: "The rejection reason was missing or outside 3–500 chars.",
    },
  },
});

export const registerAdminRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { runAuth } = makeRun(runtime);

  app.openapi(list, (c) => {
    const { limit, cursor } = c.req.valid("query");
    return runAuth(
      c,
      Effect.gen(function* () {
        const service = yield* AdminService;
        const page = yield* service.listPending(limit, cursor);
        return c.json({ data: page.data.map(toResponse), meta: page.meta }, 200);
      }),
    );
  });

  app.openapi(detail, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const service = yield* AdminService;
        const result = yield* service.getDetail(c.req.valid("param").id);
        return c.json(
          {
            practitioner: toResponse(result.practitioner),
            cmcRegistrationNumber: result.cmcRegistrationNumber,
            nicNumber: result.nicNumber,
            documents: result.documents,
          },
          200,
        );
      }),
    ),
  );

  app.openapi(approve, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const service = yield* AdminService;
        const updated = yield* service.approve(c.req.valid("param").id);
        return c.json(toResponse(updated), 200);
      }),
    ),
  );

  app.openapi(reject, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const service = yield* AdminService;
        const updated = yield* service.reject(c.req.valid("param").id, c.req.valid("json").reason);
        return c.json(toResponse(updated), 200);
      }),
    ),
  );
};
