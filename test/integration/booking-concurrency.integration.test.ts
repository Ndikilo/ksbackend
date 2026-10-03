import type { SqlError } from "@effect/sql";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BookAppointmentInput } from "@/domain/appointment/appointment";
import { SlotTaken } from "@/domain/appointment/errors";
import type { ConsultationType } from "@/domain/practitioner/practitioner";
import { Forbidden, NotFound, ValidationFailed } from "@/domain/shared/errors";
import { user } from "@/db/schema/auth";
import { appointment as appointmentTable } from "@/db/schema/appointment";
import { availabilitySlot } from "@/db/schema/availability-slot";
import { caregiverLink } from "@/db/schema/caregiver-link";
import { consultationOffering } from "@/db/schema/consultation-offering";
import { dependent } from "@/db/schema/dependent";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import { profession } from "@/db/schema/profession";
import { IdGeneratorLive } from "@/infra/ids";
import { AppointmentRepoLive } from "@/modules/appointment/appointment.repo";
import {
  AppointmentService,
  AppointmentServiceLive,
} from "@/modules/appointment/appointment.service";
import { DependentRepoLive } from "@/modules/dependent/dependent.repo";
import { OfferingRepoLive } from "@/modules/offering/offering.repo";
import { PractitionerRepoLive } from "@/modules/practitioner/practitioner.repo";
import { databaseLayerFromUrl, startTestPostgres } from "../support/testcontainers";

/**
 * P3.T2 — the booking service against a real Postgres. The heart of the suite
 * is the concurrency proof: two bookings race for the same slot, the row lock
 * (`SELECT … FOR UPDATE`) serializes them, and EXACTLY ONE wins while the
 * loser fails with the typed SlotTaken (→ 409 SLOT_TAKEN). Removing the lock
 * turns the loser's failure into a unique-index SqlError (red: wrong error),
 * removing both lets two winners through (red: double booking).
 */

type BookingError = SlotTaken | ValidationFailed | NotFound | Forbidden | SqlError.SqlError;

type BookAppointmentOutput = import("@/domain/appointment/appointment").Appointment;

/** The typed failure of a settled booking (undefined on success). */
const failureOf = (
  exit: Exit.Exit<BookAppointmentOutput, BookingError>,
): BookingError | undefined =>
  Exit.isSuccess(exit) ? undefined : Option.getOrUndefined(Cause.failureOption(exit.cause));

describe("booking service (integration) — atomic slot lock", () => {
  let runtime: ManagedRuntime.ManagedRuntime<AppointmentService, SqlError.SqlError>;
  let book: (
    patientUserId: string,
    input: BookAppointmentInput,
  ) => Effect.Effect<BookAppointmentOutput, BookingError>;
  let bookExit: (
    patientUserId: string,
    input: BookAppointmentInput,
  ) => Effect.Effect<Exit.Exit<BookAppointmentOutput, BookingError>, never>;
  let db: ReturnType<typeof drizzle>;
  let stopPg: () => Promise<void>;
  let practitionerId: string;
  let offeringId: string;
  let altOfferingId: string;
  let dependentId: string;
  const patientA = "user-patient-a";
  const patientB = "user-patient-b";

  /** practitioner's future 60-min slot of the given consultation types. */
  const seedBookable = async (
    minutesAhead: number,
    consultationTypes: ConsultationType[] = ["in_person"],
  ) => {
    const slotId = crypto.randomUUID();
    const startsAt = new Date(Date.now() + minutesAhead * 60_000);
    const endsAt = new Date(startsAt.getTime() + 60 * 60_000);
    await db.insert(availabilitySlot).values({
      id: slotId,
      practitionerProfileId: practitionerId,
      startsAt,
      endsAt,
      consultationTypes,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return slotId;
  };

  const seedPastSlot = async () => {
    const slotId = crypto.randomUUID();
    const startsAt = new Date(Date.now() - 60 * 60_000);
    await db.insert(availabilitySlot).values({
      id: slotId,
      practitionerProfileId: practitionerId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      consultationTypes: ["in_person"],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return slotId;
  };

  beforeAll(async () => {
    const pg = await startTestPostgres();
    stopPg = pg.stop;
    db = drizzle(pg.url);
    const Database = databaseLayerFromUrl(pg.url);
    runtime = ManagedRuntime.make(
      AppointmentServiceLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            AppointmentRepoLive.pipe(Layer.provide(Database)),
            OfferingRepoLive.pipe(Layer.provide(Database)),
            DependentRepoLive.pipe(Layer.provide(Database)),
            PractitionerRepoLive.pipe(Layer.provide(Database)),
            IdGeneratorLive,
            Database,
          ),
        ),
      ),
    );
    // A Context.Tag IS an effect that reads itself from the provided context.
    const service = await runtime.runPromise(AppointmentService);
    book = (patientUserId, input) => service.book(patientUserId, input);
    bookExit = (patientUserId, input) => Effect.exit(service.book(patientUserId, input));

    // — Fixture: one practitioner with two offerings, one dependent linked to
    //   patientA, three accounts. Direct inserts (service-level test — the
    //   onboarding flows are covered by the api tier).
    const professionId = crypto.randomUUID();
    await db.insert(profession).values({ id: professionId, nameEn: "Doctor", nameFr: "Médecin" });
    await db.insert(user).values([
      {
        id: "user-practitioner",
        name: "Practitioner",
        email: "practitioner@example.com",
        emailVerified: true,
        role: "practitioner",
      },
      { id: patientA, name: "Patient A", email: "patient-a@example.com", emailVerified: true },
      { id: patientB, name: "Patient B", email: "patient-b@example.com", emailVerified: true },
    ]);
    practitionerId = crypto.randomUUID();
    await db.insert(practitionerProfile).values({
      id: practitionerId,
      userId: "user-practitioner",
      professionId,
    });
    offeringId = crypto.randomUUID();
    altOfferingId = crypto.randomUUID();
    await db.insert(consultationOffering).values([
      {
        id: offeringId,
        practitionerProfileId: practitionerId,
        consultationType: "in_person",
        durationMin: 60,
        priceXaf: 5000,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: altOfferingId,
        practitionerProfileId: practitionerId,
        consultationType: "video",
        durationMin: 30,
        priceXaf: 2500,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    dependentId = crypto.randomUUID();
    await db.insert(dependent).values({
      id: dependentId,
      surname: "Doe",
      givenNames: "Junior",
      dateOfBirth: "2020-01-01",
      sex: "male",
    });
    await db.insert(caregiverLink).values({
      id: crypto.randomUUID(),
      caregiverUserId: patientA,
      managedDependentId: dependentId,
      relationship: "child",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }, 120_000);

  afterAll(async () => {
    await runtime.dispose();
    await db.$client.end();
    await stopPg();
  });

  it("two concurrent bookings on one slot produce exactly one winner; the loser gets SlotTaken", async () => {
    const slotId = await seedBookable(7 * 24 * 60);

    const [first, second] = await runtime.runPromise(
      Effect.all(
        [bookExit(patientA, { slotId, offeringId }), bookExit(patientB, { slotId, offeringId })],
        { concurrency: 2 },
      ),
    );

    // Exactly one winner — either fiber may take the lock first.
    expect([first, second].filter(Exit.isSuccess)).toHaveLength(1);
    const loser = Exit.isSuccess(first) ? second : first;
    expect(failureOf(loser)).toBeInstanceOf(SlotTaken);

    // Exactly one appointment row (snapshots intact); the slot flipped to booked.
    const appointments = await db.select().from(appointmentTable);
    expect(appointments).toHaveLength(1);
    expect(appointments[0]?.slotId).toBe(slotId);
    expect(appointments[0]?.status).toBe("pending");
    expect(appointments[0]?.priceXaf).toBe(5000);
    expect(appointments[0]?.cancellationNoticeHours).toBe(24);
    const slots = await db.select().from(availabilitySlot).where(eq(availabilitySlot.id, slotId));
    expect(slots[0]?.status).toBe("booked");
  });

  it("rejects a second sequential booking on a booked slot with SlotTaken", async () => {
    const slotId = await seedBookable(8 * 24 * 60);
    const winner = await runtime.runPromise(book(patientA, { slotId, offeringId }));
    expect(winner.status).toBe("pending");

    const loser = await runtime.runPromise(bookExit(patientB, { slotId, offeringId }));
    expect(Exit.isSuccess(loser)).toBe(false);
    expect(failureOf(loser)).toBeInstanceOf(SlotTaken);
  });

  it("rejects started slots, mismatched offerings, unknown offerings and unlinked dependents", async () => {
    // Past slot → ValidationFailed (data hygiene, not a contention signal).
    const pastSlotId = await seedPastSlot();
    const past = await runtime.runPromise(bookExit(patientA, { slotId: pastSlotId, offeringId }));
    expect(failureOf(past)).toBeInstanceOf(ValidationFailed);

    // Same practitioner's offering but type/duration do not fit the slot.
    const slotId = await seedBookable(9 * 24 * 60);
    const mismatch = await runtime.runPromise(
      bookExit(patientA, { slotId, offeringId: altOfferingId }),
    );
    expect(failureOf(mismatch)).toBeInstanceOf(ValidationFailed);

    // Unknown offering → NotFound.
    const unknownOffering = await runtime.runPromise(
      bookExit(patientA, { slotId, offeringId: crypto.randomUUID() }),
    );
    expect(failureOf(unknownOffering)).toBeInstanceOf(NotFound);

    // patientB does not manage patientA's dependent → Forbidden.
    const unlinked = await runtime.runPromise(
      bookExit(patientB, { slotId, offeringId, dependentId }),
    );
    expect(failureOf(unlinked)).toBeInstanceOf(Forbidden);
  });

  it("books for a linked dependent and snapshots the offering terms", async () => {
    const slotId = await seedBookable(10 * 24 * 60);
    const appointment = await runtime.runPromise(
      book(patientA, { slotId, offeringId, dependentId }),
    );
    expect(appointment.dependentId).toBe(dependentId);
    expect(appointment.patientUserId).toBe(patientA);
    expect(appointment.consultationType).toBe("in_person");
    expect(appointment.priceXaf).toBe(5000);
    expect(appointment.cancelledAt).toBeNull();
  });
});
