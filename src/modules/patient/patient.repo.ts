import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { user } from "@/db/schema/auth";
import { patientProfile } from "@/db/schema/patient-profile";
import { profile } from "@/db/schema/profile";
import type { EmergencyContact, Patient } from "@/domain/patient/patient";
import { parseRoles, serializeRoles } from "@/infra/auth";

type ProfileRow = typeof profile.$inferSelect;
type PatientRow = typeof patientProfile.$inferSelect;

const toEmergencyContact = (row: PatientRow): EmergencyContact | null =>
  row.emergencyContactName === null ||
  row.emergencyContactPhone === null ||
  row.emergencyContactRelationship === null
    ? null
    : {
        name: row.emergencyContactName,
        phone: row.emergencyContactPhone,
        relationship: row.emergencyContactRelationship,
      };

const toDomain = (base: ProfileRow, patient: PatientRow): Patient => ({
  id: base.id,
  userId: base.userId,
  surname: base.surname,
  givenNames: base.givenNames,
  phone: base.phone,
  dateOfBirth: base.dateOfBirth,
  sex: base.sex,
  avatarFileKey: base.avatarFileKey,
  consentAcceptedAt: base.consentAcceptedAt,
  consentVersion: base.consentVersion,
  emergencyContact: toEmergencyContact(patient),
});

export interface PatientRepoService {
  readonly findByUserId: (userId: string) => Effect.Effect<Patient | undefined, SqlError.SqlError>;
  /** Create-or-update the patient marker + emergency contact (idempotent). */
  readonly upsert: (
    id: string,
    userId: string,
    emergencyContact: EmergencyContact | null,
    updatedAt: Date,
  ) => Effect.Effect<void, SqlError.SqlError>;
  /**
   * Ensure a patient marker row exists WITHOUT touching emergency-contact data.
   * Used by role self-grant, which must never clobber a completed profile.
   */
  readonly ensureMarker: (id: string, userId: string) => Effect.Effect<void, SqlError.SqlError>;
  /** Add the `patient` role to the user (idempotent via role-set dedup). */
  readonly grantPatientRole: (userId: string) => Effect.Effect<void, SqlError.SqlError>;
}

export class PatientRepo extends Context.Tag("PatientRepo")<PatientRepo, PatientRepoService>() {}

export const PatientRepoLive = Layer.effect(
  PatientRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    return {
      findByUserId: (userId) =>
        db
          .select({ base: profile, patient: patientProfile })
          .from(patientProfile)
          .innerJoin(profile, eq(patientProfile.userId, profile.userId))
          .where(eq(patientProfile.userId, userId))
          .limit(1)
          .pipe(
            Effect.map((rows) => (rows[0] ? toDomain(rows[0].base, rows[0].patient) : undefined)),
          ),

      grantPatientRole: (userId) =>
        db
          .select({ role: user.role })
          .from(user)
          .where(eq(user.id, userId))
          .limit(1)
          .pipe(
            Effect.flatMap((rows) => {
              const next = serializeRoles([...parseRoles(rows[0]?.role), "patient"]);
              return db.update(user).set({ role: next }).where(eq(user.id, userId));
            }),
            Effect.asVoid,
          ),

      upsert: (id, userId, emergencyContact, updatedAt) =>
        db
          .insert(patientProfile)
          .values({
            id,
            userId,
            emergencyContactName: emergencyContact?.name ?? null,
            emergencyContactPhone: emergencyContact?.phone ?? null,
            emergencyContactRelationship: emergencyContact?.relationship ?? null,
          })
          .onConflictDoUpdate({
            target: patientProfile.userId,
            set: {
              emergencyContactName: emergencyContact?.name ?? null,
              emergencyContactPhone: emergencyContact?.phone ?? null,
              emergencyContactRelationship: emergencyContact?.relationship ?? null,
              updatedAt,
            },
          })
          .pipe(Effect.asVoid),

      ensureMarker: (id, userId) =>
        db
          .insert(patientProfile)
          .values({ id, userId })
          .onConflictDoNothing({ target: patientProfile.userId })
          .pipe(Effect.asVoid),
    };
  }),
);
