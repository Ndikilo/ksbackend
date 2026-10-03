import { SqlClient, SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";
import { z } from "zod";

import type {
  Appointment,
  AppointmentStatus,
  BookAppointmentInput,
  BookingPolicy,
} from "@/domain/appointment/appointment";
import {
  AppointmentStarted,
  AppointmentStateInvalid,
  SlotTaken,
} from "@/domain/appointment/errors";
import { judgeCancellation, judgeReschedule } from "@/domain/appointment/policy";
import { Forbidden, NotFound, ValidationFailed } from "@/domain/shared/errors";
import { IdGenerator } from "@/infra/ids";
import type { Role } from "@/infra/auth";
import { decodeCursor, encodeCursor } from "@/lib/cursor";
import { DependentRepo } from "@/modules/dependent/dependent.repo";
import { OfferingRepo } from "@/modules/offering/offering.repo";
import { PractitionerRepo } from "@/modules/practitioner/practitioner.repo";
import { AppointmentRepo, type AppointmentCursor } from "./appointment.repo";

export type AppointmentPage = {
  readonly data: ReadonlyArray<Appointment>;
  readonly meta: {
    readonly count: number;
    readonly limit: number;
    readonly nextCursor: string | null;
    readonly hasNextPage: boolean;
  };
};

/** Who is asking — the session user (id + roles) drives role-aware reads. */
export type AppointmentCaller = {
  readonly id: string;
  readonly roles: ReadonlyArray<Role>;
};

/** Which side of the calendar to list: the caller's bookings or their agenda. */
export type ListScope = "patient" | "practitioner";

export type ListAppointmentsInput = {
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly scope?: ListScope | undefined;
  readonly status?: AppointmentStatus | undefined;
};

// The list cursor carries the keyset position (starts_at, id). base64url-blind
// clients via lib/cursor; the payload is decoded WITH a schema (never cast) —
// a malformed or forged cursor is a 422, never a 500.
const CursorKey = z.object({ s: z.iso.datetime(), i: z.uuid() });
const encodeAppointmentCursor = (position: AppointmentCursor): string =>
  encodeCursor(JSON.stringify({ s: position.startsAt.toISOString(), i: position.id }));
const decodeAppointmentCursor = (
  cursor: string,
): Effect.Effect<AppointmentCursor, ValidationFailed> =>
  Effect.try({
    try: () => {
      const parsed = CursorKey.parse(JSON.parse(decodeCursor(cursor)));
      return { startsAt: new Date(parsed.s), id: parsed.i };
    },
    catch: () => new ValidationFailed({ issues: [{ path: "cursor", message: "Invalid cursor." }] }),
  });

export interface AppointmentServiceService {
  /**
   * Book one availability slot for the patient themself (`dependentId`
   * omitted) or a managed dependent. Atomic: the slot row is locked for the
   * whole transaction, so of two concurrent bookings on one slot EXACTLY ONE
   * wins — the loser fails with `SlotTaken` (409 SLOT_TAKEN). The partial
   * unique index `appointment_slot_active_unique` is the DB-level backstop.
   */
  readonly book: (
    patientUserId: string,
    input: BookAppointmentInput,
  ) => Effect.Effect<
    Appointment,
    SlotTaken | ValidationFailed | NotFound | Forbidden | SqlError.SqlError
  >;
  /**
   * Role-aware page: `scope: "patient"` (the default) lists the caller's own
   * + their managed dependents' bookings; `scope: "practitioner"` lists the
   * practitioner's calendar (requires the doctor/nurse role AND a practitioner
   * profile). Newest start first, keyset-paginated on (startsAt, id).
   */
  readonly list: (
    caller: AppointmentCaller,
    input: ListAppointmentsInput,
  ) => Effect.Effect<AppointmentPage, ValidationFailed | Forbidden | NotFound | SqlError.SqlError>;
  /** One appointment — visible ONLY to the booking patient or the practitioner; others get 404. */
  readonly get: (
    caller: AppointmentCaller,
    id: string,
  ) => Effect.Effect<Appointment, NotFound | SqlError.SqlError>;
  /**
   * Patient-or-practitioner cancellation. Judged by the booking-time policy
   * snapshot: before the notice window the cancellation is on time; inside it
   * the cancellation is ALLOWED but stamped `lateCancellation` (the snapshot
   * fee then applies at settlement — P5). Practitioner-initiated cancels are
   * never late (the fee exists to protect the practitioner's time). Frees the
   * slot for rebooking in the same transaction.
   */
  readonly cancel: (
    caller: AppointmentCaller,
    id: string,
  ) => Effect.Effect<
    Appointment,
    NotFound | AppointmentStateInvalid | AppointmentStarted | SqlError.SqlError
  >;
  /**
   * Move an actionable appointment to another open slot of the SAME
   * practitioner (duration + consultation type must still fit the slot). The
   * old slot is freed and the new one booked in one transaction — a lost race
   * for the new slot fails with `SlotTaken`.
   */
  readonly reschedule: (
    caller: AppointmentCaller,
    id: string,
    newSlotId: string,
  ) => Effect.Effect<
    Appointment,
    | NotFound
    | SlotTaken
    | ValidationFailed
    | AppointmentStateInvalid
    | AppointmentStarted
    | SqlError.SqlError
  >;
  /**
   * The caller's own booking policy (P3.T5): the notice window + late fee
   * stamped onto NEW bookings. Practitioner-only (403 without the role, 404
   * without a practitioner profile).
   */
  readonly getPolicy: (
    caller: AppointmentCaller,
  ) => Effect.Effect<BookingPolicy, Forbidden | NotFound | SqlError.SqlError>;
  /** Replace the caller's booking policy; takes effect for future bookings only. */
  readonly putPolicy: (
    caller: AppointmentCaller,
    policy: BookingPolicy,
  ) => Effect.Effect<BookingPolicy, Forbidden | NotFound | SqlError.SqlError>;
}

export class AppointmentService extends Context.Tag("AppointmentService")<
  AppointmentService,
  AppointmentServiceService
>() {}

const isPractitionerRole = (caller: AppointmentCaller): boolean =>
  caller.roles.includes("doctor") || caller.roles.includes("nurse");

export const AppointmentServiceLive = Layer.effect(
  AppointmentService,
  Effect.gen(function* () {
    const repo = yield* AppointmentRepo;
    const offerings = yield* OfferingRepo;
    const dependents = yield* DependentRepo;
    const practitioners = yield* PractitionerRepo;
    const ids = yield* IdGenerator;
    const sql = yield* SqlClient.SqlClient;

    const now: Effect.Effect<Date> = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms));

    /**
     * Resolve the caller's practitioner profile for practitioner-only
     * operations: 403 without the doctor/nurse role, 404 with the role but no
     * profile (same semantics as the availability module).
     */
    const requirePractitionerProfile = (
      caller: AppointmentCaller,
    ): Effect.Effect<string, Forbidden | NotFound | SqlError.SqlError> => {
      if (!isPractitionerRole(caller)) {
        return Effect.fail(
          new Forbidden({ reason: "This action requires the doctor/nurse role." }),
        );
      }
      return Effect.flatMap(practitioners.findByUserId(caller.id), (profile) =>
        profile
          ? Effect.succeed(profile.id)
          : Effect.fail(new NotFound({ resource: "Practitioner profile", id: caller.id })),
      );
    };

    /**
     * The caller is a party to the appointment iff they are the booking
     * patient, or the appointment's practitioner themself. Everyone else —
     * including other patients and other practitioners — gets the same 404
     * as an unknown id: existence is never leaked (codebase-wide semantics).
     */
    const resolveVisible = (
      caller: AppointmentCaller,
      appointment: Appointment,
    ): Effect.Effect<Appointment, NotFound | SqlError.SqlError> => {
      const notFound = Effect.fail(new NotFound({ resource: "Appointment", id: appointment.id }));
      if (appointment.patientUserId === caller.id) {
        return Effect.succeed(appointment);
      }
      const isPractitioner = caller.roles.includes("doctor") || caller.roles.includes("nurse");
      if (!isPractitioner) {
        return notFound;
      }
      return Effect.flatMap(practitioners.findByUserId(caller.id), (profile) =>
        profile !== undefined && profile.id === appointment.practitionerProfileId
          ? Effect.succeed(appointment)
          : notFound,
      );
    };

    const book = (patientUserId: string, input: BookAppointmentInput) =>
      Effect.gen(function* () {
        const at = yield* now;
        // The offering is resolved BEFORE the transaction: it only feeds the
        // coherence checks + snapshots, so it needs no lock (soft-deleted or
        // deactivated offerings simply fail the checks below).
        const offering = yield* offerings.findActiveById(input.offeringId);
        if (!offering) {
          return yield* Effect.fail(
            new NotFound({ resource: "Consultation offering", id: input.offeringId }),
          );
        }
        if (input.dependentId !== undefined) {
          const linked = yield* dependents.findForCaregiver(patientUserId, input.dependentId);
          if (!linked) {
            return yield* Effect.fail(
              new Forbidden({ reason: "Dependent is not managed by this account." }),
            );
          }
        }

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            // Serialization point: concurrent bookings on this slot queue here.
            const slot = yield* repo.lockSlotById(input.slotId);
            if (!slot) {
              return yield* Effect.fail(
                new NotFound({ resource: "Availability slot", id: input.slotId }),
              );
            }
            if (slot.practitionerProfileId !== offering.practitionerProfileId) {
              return yield* Effect.fail(
                new ValidationFailed({
                  issues: [
                    {
                      path: "offeringId",
                      message: "Offering does not belong to this slot's practitioner.",
                    },
                  ],
                }),
              );
            }
            if (slot.deletedAt !== null || slot.status !== "open") {
              return yield* Effect.fail(new SlotTaken({}));
            }
            if (slot.startsAt.getTime() <= at.getTime()) {
              return yield* Effect.fail(
                new ValidationFailed({
                  issues: [{ path: "slotId", message: "Slot has already started." }],
                }),
              );
            }
            const slotMinutes = (slot.endsAt.getTime() - slot.startsAt.getTime()) / 60_000;
            if (slotMinutes !== offering.durationMin) {
              return yield* Effect.fail(
                new ValidationFailed({
                  issues: [
                    {
                      path: "offeringId",
                      message: "Offering duration does not match the slot length.",
                    },
                  ],
                }),
              );
            }
            if (!slot.consultationTypes.includes(offering.consultationType)) {
              return yield* Effect.fail(
                new ValidationFailed({
                  issues: [
                    {
                      path: "offeringId",
                      message: "Offering consultation type is not offered on this slot.",
                    },
                  ],
                }),
              );
            }

            // Stamp the practitioner's CURRENT booking policy (P3.T5) — the
            // snapshot is what the appointment is later judged by, so policy
            // edits never reach existing bookings.
            const policy = yield* repo.policyForPractitioner(slot.practitionerProfileId);
            const appointment = yield* repo.insertAppointment({
              id: yield* ids.next,
              patientUserId,
              dependentId: input.dependentId ?? null,
              practitionerProfileId: slot.practitionerProfileId,
              slotId: slot.id,
              consultationOfferingId: offering.id,
              consultationType: offering.consultationType,
              startsAt: slot.startsAt,
              endsAt: slot.endsAt,
              priceXaf: offering.priceXaf,
              cancellationNoticeHours: policy.noticeHours,
              cancellationFeeXaf: policy.feeXaf,
              createdAt: at,
              updatedAt: at,
            });
            yield* repo.markSlotBooked(slot.id, at);
            return appointment;
          }),
        );
      });

    const list = (caller: AppointmentCaller, input: ListAppointmentsInput) =>
      Effect.gen(function* () {
        const before =
          input.cursor === undefined ? undefined : yield* decodeAppointmentCursor(input.cursor);

        let owner: Effect.Effect<string, NotFound | Forbidden | SqlError.SqlError>;
        if (input.scope === "practitioner") {
          if (!isPractitionerRole(caller)) {
            return yield* Effect.fail(
              new Forbidden({
                reason: "The practitioner calendar requires the doctor/nurse role.",
              }),
            );
          }
          owner = requirePractitionerProfile(caller);
        } else {
          owner = Effect.succeed(caller.id);
        }

        const ownerKey = yield* owner;
        const rows =
          input.scope === "practitioner"
            ? yield* repo.listForPractitioner(ownerKey, input.limit + 1, before, input.status)
            : yield* repo.listForPatient(ownerKey, input.limit + 1, before, input.status);

        const hasNextPage = rows.length > input.limit;
        const data = hasNextPage ? rows.slice(0, input.limit) : rows;
        const last = data.at(-1);
        return {
          data,
          meta: {
            count: data.length,
            limit: input.limit,
            nextCursor:
              hasNextPage && last
                ? encodeAppointmentCursor({ startsAt: last.startsAt, id: last.id })
                : null,
            hasNextPage,
          },
        } satisfies AppointmentPage;
      });

    const get = (caller: AppointmentCaller, id: string) =>
      Effect.flatMap(repo.findById(id), (found) =>
        found === undefined
          ? Effect.fail(new NotFound({ resource: "Appointment", id }))
          : resolveVisible(caller, found),
      );

    const cancel = (caller: AppointmentCaller, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const at = yield* now;
          // Serialize concurrent mutations of this appointment (double cancel,
          // cancel-vs-reschedule) — the second re-reads state after the first.
          const appointment = yield* repo.lockById(id);
          if (appointment === undefined) {
            return yield* Effect.fail(new NotFound({ resource: "Appointment", id }));
          }
          yield* resolveVisible(caller, appointment);
          // The rules engine (P3.T5) judges by the booking-time snapshot.
          const judgement = judgeCancellation(
            appointment,
            at,
            appointment.patientUserId === caller.id,
          );
          if (judgement.kind === "not-actionable") {
            return yield* Effect.fail(new AppointmentStateInvalid({ current: judgement.current }));
          }
          if (judgement.kind === "started") {
            return yield* Effect.fail(new AppointmentStarted({}));
          }

          const cancelled = yield* repo.cancelAppointment(id, {
            byUserId: caller.id,
            late: judgement.kind === "late",
            now: at,
          });
          yield* repo.markSlotOpen(appointment.slotId, at);
          return cancelled;
        }),
      );

    const reschedule = (caller: AppointmentCaller, id: string, newSlotId: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const at = yield* now;
          const appointment = yield* repo.lockById(id);
          if (appointment === undefined) {
            return yield* Effect.fail(new NotFound({ resource: "Appointment", id }));
          }
          yield* resolveVisible(caller, appointment);
          const judgement = judgeReschedule(appointment, at);
          if (judgement.kind === "not-actionable") {
            return yield* Effect.fail(new AppointmentStateInvalid({ current: judgement.current }));
          }
          if (judgement.kind === "started") {
            return yield* Effect.fail(new AppointmentStarted({}));
          }
          // Moving to the slot it already occupies is a no-op — an idempotent
          // retry of an interrupted request must not 409 on itself.
          if (newSlotId === appointment.slotId) {
            return appointment;
          }

          // Lock the target slot: bookings and other reschedules queue here,
          // so the winner of a race takes the slot and the loser sees it no
          // longer open (SlotTaken).
          const slot = yield* repo.lockSlotById(newSlotId);
          if (!slot) {
            return yield* Effect.fail(
              new NotFound({ resource: "Availability slot", id: newSlotId }),
            );
          }
          if (slot.practitionerProfileId !== appointment.practitionerProfileId) {
            return yield* Effect.fail(
              new ValidationFailed({
                issues: [{ path: "slotId", message: "Slot belongs to a different practitioner." }],
              }),
            );
          }
          if (slot.deletedAt !== null || slot.status !== "open") {
            return yield* Effect.fail(new SlotTaken({}));
          }
          if (slot.startsAt.getTime() <= at.getTime()) {
            return yield* Effect.fail(
              new ValidationFailed({
                issues: [{ path: "slotId", message: "Slot has already started." }],
              }),
            );
          }
          const slotMinutes = (slot.endsAt.getTime() - slot.startsAt.getTime()) / 60_000;
          const appointmentMinutes =
            (appointment.endsAt.getTime() - appointment.startsAt.getTime()) / 60_000;
          if (slotMinutes !== appointmentMinutes) {
            return yield* Effect.fail(
              new ValidationFailed({
                issues: [{ path: "slotId", message: "Slot length does not match the booking." }],
              }),
            );
          }
          if (!slot.consultationTypes.includes(appointment.consultationType)) {
            return yield* Effect.fail(
              new ValidationFailed({
                issues: [
                  { path: "slotId", message: "Slot does not offer the booked consultation type." },
                ],
              }),
            );
          }

          yield* repo.markSlotOpen(appointment.slotId, at);
          return yield* repo.rescheduleAppointment(id, {
            slotId: slot.id,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            now: at,
          });
        }),
      );

    const getPolicy = (caller: AppointmentCaller) =>
      Effect.flatMap(requirePractitionerProfile(caller), repo.policyForPractitioner);

    const putPolicy = (caller: AppointmentCaller, policy: BookingPolicy) =>
      Effect.gen(function* () {
        const profileId = yield* requirePractitionerProfile(caller);
        const updated = yield* repo.updatePolicy(profileId, {
          noticeHours: policy.noticeHours,
          feeXaf: policy.feeXaf,
          now: yield* now,
        });
        return updated === undefined
          ? yield* Effect.fail(new NotFound({ resource: "Practitioner profile", id: profileId }))
          : updated;
      });

    return { book, list, get, cancel, reschedule, getPolicy, putPolicy };
  }),
);
