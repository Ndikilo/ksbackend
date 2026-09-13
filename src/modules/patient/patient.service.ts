import { SqlClient, SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";
import type { Patient, PatientProfileInput } from "@/domain/patient/patient";
import { IdGenerator } from "@/infra/ids";
import { ProfileRepo } from "@/modules/profile/profile.repo";
import { PatientRepo } from "./patient.repo";

export interface PatientServiceService {
  readonly getProfile: (userId: string) => Effect.Effect<Patient | undefined, SqlError.SqlError>;
  readonly completeProfile: (
    userId: string,
    input: PatientProfileInput,
  ) => Effect.Effect<Patient, SqlError.SqlError>;
  /** Self-grant the patient role (any user can become a care recipient). */
  readonly claimRole: (userId: string) => Effect.Effect<void, SqlError.SqlError>;
}

export class PatientService extends Context.Tag("PatientService")<
  PatientService,
  PatientServiceService
>() {}

export const PatientServiceLive = Layer.effect(
  PatientService,
  Effect.gen(function* () {
    const repo = yield* PatientRepo;
    const profiles = yield* ProfileRepo;
    const ids = yield* IdGenerator;
    const sql = yield* SqlClient.SqlClient;

    return {
      getProfile: (userId) => repo.findByUserId(userId),

      completeProfile: (userId, input) =>
        Effect.gen(function* () {
          const existing = yield* profiles.findByUserId(userId);
          const profileId = existing?.id ?? (yield* ids.next);
          const patientId = yield* ids.next;
          const now = new Date(yield* Clock.currentTimeMillis);
          // Base profile + patient marker (with emergency contact) are one atomic unit.
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* profiles.upsert({
                id: profileId,
                userId,
                surname: input.surname,
                givenNames: input.givenNames,
                phone: input.phone ?? null,
                dateOfBirth: input.dateOfBirth,
                sex: input.sex,
                consentAcceptedAt: now,
                consentVersion: input.consentVersion,
              });
              yield* repo.upsert(patientId, userId, input.emergencyContact ?? null, now);
            }),
          );
          const saved = yield* repo.findByUserId(userId);
          return saved ?? (yield* Effect.dieMessage("patient missing after upsert"));
        }),

      claimRole: (userId) =>
        Effect.gen(function* () {
          const patientId = yield* ids.next;
          // Role + marker are one atomic unit. `ensureMarker` never overwrites an
          // existing profile's emergency contact — self-granting the role is a
          // no-op for anyone who already completed their patient profile.
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* repo.grantPatientRole(userId);
              yield* repo.ensureMarker(patientId, userId);
            }),
          );
        }),
    };
  }),
);
