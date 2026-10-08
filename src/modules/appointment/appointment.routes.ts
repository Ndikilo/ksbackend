import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";

import type { Appointment } from "@/domain/appointment/appointment";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { ErrorResponse } from "@/http/schemas";
import { CurrentUser } from "@/infra/auth";
import type { AppointmentListRow } from "./appointment.repo";
import {
  AppointmentIdParam,
  AppointmentResponse,
  AppointmentsPage,
  BookAppointmentBody,
  BookingPolicyBody,
  BookingPolicyResponse,
  ListAppointmentsQuery,
  RescheduleAppointmentBody,
} from "./appointment.contract";
import { AppointmentService } from "./appointment.service";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });

const toResponse = (a: Appointment) => ({
  id: a.id,
  patientUserId: a.patientUserId,
  dependentId: a.dependentId,
  practitionerProfileId: a.practitionerProfileId,
  slotId: a.slotId,
  consultationOfferingId: a.consultationOfferingId,
  status: a.status,
  consultationType: a.consultationType,
  startsAt: a.startsAt.toISOString(),
  endsAt: a.endsAt.toISOString(),
  priceXaf: a.priceXaf,
  cancellationNoticeHours: a.cancellationNoticeHours,
  cancellationFeeXaf: a.cancellationFeeXaf,
  lateCancellation: a.lateCancellation,
  cancelledAt: a.cancelledAt === null ? null : a.cancelledAt.toISOString(),
  cancelledByUserId: a.cancelledByUserId,
  // Persona names are LIST-only data (P7.T1): single-appointment responses
  // name neither side — the caller is always a party to what they fetched.
  patientName: null,
  practitionerName: null,
});

const toListResponse = (row: AppointmentListRow) => ({
  ...toResponse(row.appointment),
  // The list names the OTHER side of the booking (P7.T1); the caller's own
  // side stays null.
  patientName: row.patientName,
  practitionerName: row.practitionerName,
});

const book = createRoute({
  method: "post",
  path: "/v1/appointments",
  tags: ["Appointments"],
  summary: "Book an appointment",
  description: [
    "Reserve one availability slot for the caller or a managed dependent. The booking is ATOMIC:",
    "of two concurrent bookings on the same slot exactly one wins — the loser gets `409",
    "SLOT_TAKEN` and must pick another slot. The offering must belong to the slot's practitioner",
    "and fit it (type + duration, `422` otherwise); a dependent must be managed by the caller",
    "(`403`). Commercial terms and the practitioner's cancellation policy (notice window, fee)",
    "are snapshotted onto the booking, so later price/policy edits never change existing",
    "appointments.",
  ].join(" "),
  request: { body: jsonBody(BookAppointmentBody) },
  responses: {
    201: {
      ...jsonBody(AppointmentResponse),
      description: "The new appointment (status `pending`).",
    },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: { ...jsonBody(ErrorResponse), description: "The dependent is not managed by the caller." },
    404: {
      ...jsonBody(ErrorResponse),
      description: "Unknown offering or slot.",
    },
    409: {
      ...jsonBody(ErrorResponse),
      description: "`SLOT_TAKEN` — the slot was just booked or is no longer bookable.",
    },
    422: {
      ...jsonBody(ErrorResponse),
      description: "Coherence failure (slot started, offering mismatch) or field validation.",
    },
  },
});

const list = createRoute({
  method: "get",
  path: "/v1/appointments",
  tags: ["Appointments"],
  summary: "List appointments (role-aware)",
  description: [
    "Cursor-paginated list, newest start first. By default the caller sees their own and their",
    "managed dependents' bookings. Practitioners pass `?scope=practitioner` to read their",
    "professional agenda instead (requires the doctor/nurse role — `403` — and a practitioner",
    "profile — `404`). Other users' appointments are never visible, and a forged or stale",
    "`cursor` is `422`. Filter by `status` to split upcoming from past client-side. Each row",
    "names the OTHER party: practitioner-scope rows carry `patientName` (the person booked for —",
    "the dependent when booked for one, else the account holder); patient-scope rows carry",
    "`practitionerName`. The caller's own side is `null`.",
  ].join(" "),
  request: { query: ListAppointmentsQuery },
  responses: {
    200: { ...jsonBody(AppointmentsPage), description: "A page of appointments." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: {
      ...jsonBody(ErrorResponse),
      description: "`scope=practitioner` requested without the doctor/nurse role.",
    },
    404: {
      ...jsonBody(ErrorResponse),
      description: "`scope=practitioner` requested but the caller has no practitioner profile.",
    },
    422: { ...jsonBody(ErrorResponse), description: "Malformed cursor." },
  },
});

const getOne = createRoute({
  method: "get",
  path: "/v1/appointments/{id}",
  tags: ["Appointments"],
  summary: "Get an appointment",
  description: [
    "Fetch one appointment. Only the booking patient (the account holder — including for their",
    "dependents) and the appointment's practitioner can see it; everyone else gets `404`,",
    "identical to an unknown id, so the existence of other people's appointments is never leaked.",
  ].join(" "),
  request: { params: AppointmentIdParam },
  responses: {
    200: { ...jsonBody(AppointmentResponse), description: "The appointment." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    404: {
      ...jsonBody(ErrorResponse),
      description:
        "No such appointment, or the caller is neither the patient nor the practitioner.",
    },
  },
});

const reschedule = createRoute({
  method: "post",
  path: "/v1/appointments/{id}/reschedule",
  tags: ["Appointments"],
  summary: "Reschedule an appointment",
  description: [
    "Move the appointment to another open slot of the SAME practitioner (idempotent when the",
    "target is the current slot). The old slot is released and the new one booked in one",
    "transaction — if someone else takes the target slot first, the reschedule fails with `409",
    "SLOT_TAKEN` and the appointment keeps its original slot. The offering (and its price",
    "snapshot) is unchanged. Legal from `pending`/`confirmed` before the start time only: other",
    "statuses → `409 APPOINTMENT_STATE_INVALID`, started/past appointments → `409",
    "APPOINTMENT_STARTED`.",
  ].join(" "),
  request: { params: AppointmentIdParam, body: jsonBody(RescheduleAppointmentBody) },
  responses: {
    200: { ...jsonBody(AppointmentResponse), description: "The rescheduled appointment." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    404: {
      ...jsonBody(ErrorResponse),
      description: "No such appointment/slot, or the caller is not a party to it.",
    },
    409: {
      ...jsonBody(ErrorResponse),
      description:
        "`SLOT_TAKEN`, `APPOINTMENT_STATE_INVALID`, or `APPOINTMENT_STARTED` — see the description.",
    },
    422: {
      ...jsonBody(ErrorResponse),
      description: "Target slot belongs to another practitioner, has started, or doesn't fit.",
    },
  },
});

const cancel = createRoute({
  method: "post",
  path: "/v1/appointments/{id}/cancel",
  tags: ["Appointments"],
  summary: "Cancel an appointment",
  description: [
    "Cancel the appointment (patient or their practitioner). Judged by the policy snapshot taken",
    "at booking: cancelled with less time remaining than `cancellationNoticeHours`, the",
    "cancellation is LATE — the response returns `lateCancellation: true` and the snapshot",
    "`cancellationFeeXaf` applies at settlement. Practitioner-initiated cancellations are never",
    "late. The slot is freed for rebooking. Illegal from any status other than",
    "`pending`/`confirmed` (`409 APPOINTMENT_STATE_INVALID`) and after the start time (`409",
    "APPOINTMENT_STARTED`).",
  ].join(" "),
  request: { params: AppointmentIdParam },
  responses: {
    200: { ...jsonBody(AppointmentResponse), description: "The cancelled appointment." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    404: {
      ...jsonBody(ErrorResponse),
      description: "No such appointment, or the caller is not a party to it.",
    },
    409: {
      ...jsonBody(ErrorResponse),
      description:
        "`APPOINTMENT_STATE_INVALID` (already cancelled/completed/no_show) or `APPOINTMENT_STARTED`.",
    },
  },
});

const confirm = createRoute({
  method: "post",
  path: "/v1/appointments/{id}/confirm",
  tags: ["Appointments"],
  summary: "Confirm an appointment",
  description: [
    "The documented booking flow's second half: a patient books (status `pending`), the",
    "appointment's practitioner CONFIRMS it (status `confirmed` — the booking is firm). Only the",
    "appointment's own practitioner may confirm: the booking patient, other practitioners and",
    "admins all get `404`, identical to an unknown id — no existence leak, no superpowers.",
    "Illegal from any status other than `pending` (`409 APPOINTMENT_STATE_INVALID`) and after",
    "the start time (`409 APPOINTMENT_STARTED`). The patient is notified through the",
    "notification outbox, enqueued in the same transaction as the state change.",
  ].join(" "),
  request: { params: AppointmentIdParam },
  responses: {
    200: { ...jsonBody(AppointmentResponse), description: "The confirmed appointment." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    404: {
      ...jsonBody(ErrorResponse),
      description: "No such appointment, or the caller is not the appointment's practitioner.",
    },
    409: {
      ...jsonBody(ErrorResponse),
      description: "`APPOINTMENT_STATE_INVALID` (not pending) or `APPOINTMENT_STARTED`.",
    },
  },
});

const getPolicy = createRoute({
  method: "get",
  path: "/v1/practitioners/me/booking-policy",
  tags: ["Appointments"],
  summary: "Read your booking policy",
  description: [
    "The cancellation policy applied to NEW bookings: the notice window (hours) and the",
    "late-cancellation fee (XAF). Existing appointments keep the snapshot taken when they were",
    "made. Requires the doctor/nurse role (`403`) and a practitioner profile (`404`). Defaults:",
    "24h / 0 XAF.",
  ].join(" "),
  responses: {
    200: { ...jsonBody(BookingPolicyResponse), description: "The current policy." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: { ...jsonBody(ErrorResponse), description: "Caller is not a practitioner." },
    404: { ...jsonBody(ErrorResponse), description: "No practitioner profile." },
  },
});

const putPolicy = createRoute({
  method: "put",
  path: "/v1/practitioners/me/booking-policy",
  tags: ["Appointments"],
  summary: "Replace your booking policy",
  description: [
    "Set the cancellation notice window (0–720 hours) and the late-cancellation fee (XAF) for",
    "NEW bookings — a patient cancelling with less time remaining than the window is late and",
    "owes the fee. Takes effect immediately for future bookings; existing appointments are",
    "judged by the snapshot they accepted. Idempotent full replace.",
  ].join(" "),
  request: { body: jsonBody(BookingPolicyBody) },
  responses: {
    200: { ...jsonBody(BookingPolicyResponse), description: "The stored policy." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: { ...jsonBody(ErrorResponse), description: "Caller is not a practitioner." },
    404: { ...jsonBody(ErrorResponse), description: "No practitioner profile." },
    422: { ...jsonBody(ErrorResponse), description: "Out-of-range window or negative fee." },
  },
});

export const registerAppointmentRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { runAuth } = makeRun(runtime);

  app.openapi(book, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AppointmentService;
        const booked = yield* service.book(user.id, c.req.valid("json"));
        return c.json(toResponse(booked), 201);
      }),
    ),
  );

  app.openapi(list, (c) => {
    const query = c.req.valid("query");
    return runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AppointmentService;
        const page = yield* service.list(user, {
          limit: query.limit,
          cursor: query.cursor,
          scope: query.scope,
          status: query.status,
        });
        return c.json({ data: page.data.map(toListResponse), meta: page.meta }, 200);
      }),
    );
  });

  app.openapi(getOne, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AppointmentService;
        const found = yield* service.get(user, c.req.valid("param").id);
        return c.json(toResponse(found), 200);
      }),
    ),
  );

  app.openapi(reschedule, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AppointmentService;
        const moved = yield* service.reschedule(
          user,
          c.req.valid("param").id,
          c.req.valid("json").slotId,
        );
        return c.json(toResponse(moved), 200);
      }),
    ),
  );

  app.openapi(cancel, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AppointmentService;
        const cancelled = yield* service.cancel(user, c.req.valid("param").id);
        return c.json(toResponse(cancelled), 200);
      }),
    ),
  );

  app.openapi(confirm, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AppointmentService;
        const confirmed = yield* service.confirm(user, c.req.valid("param").id);
        return c.json(toResponse(confirmed), 200);
      }),
    ),
  );

  app.openapi(getPolicy, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AppointmentService;
        return c.json(yield* service.getPolicy(user), 200);
      }),
    ),
  );

  app.openapi(putPolicy, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* AppointmentService;
        return c.json(yield* service.putPolicy(user, c.req.valid("json")), 200);
      }),
    ),
  );
};
