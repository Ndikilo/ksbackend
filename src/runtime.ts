import { Layer, ManagedRuntime } from "effect";
import { CryptoLive } from "./infra/crypto";
import { DatabaseLive } from "./infra/db";
import { EmailSender, EmailSenderConsoleLive, EmailSenderResendLive } from "./infra/email";
import { Geocoder, GeocoderFakeLive, GeocoderNominatimLive } from "./infra/geocoding";
import { HealthLive } from "./infra/health";
import { IdGeneratorLive } from "./infra/ids";
import { LoggerLive } from "./infra/logger";
import { RateLimiterInMemoryLive } from "./infra/rate-limiter";
import { FileScanner, FileScannerCleanLive, FileScannerS3Live } from "./infra/scanner";
import { FileStorage, FileStorageFakeLive, FileStorageS3Live } from "./infra/storage";
import { AdminRepoLive } from "./modules/admin/admin.repo";
import { AdminServiceLive } from "./modules/admin/admin.service";
import { AvailabilityRepoLive } from "./modules/availability/availability.repo";
import { AvailabilityServiceLive } from "./modules/availability/availability.service";
import { DependentRepoLive } from "./modules/dependent/dependent.repo";
import { DependentServiceLive } from "./modules/dependent/dependent.service";
import { InvitationRepoLive } from "./modules/invitation/invitation.repo";
import { InvitationServiceLive } from "./modules/invitation/invitation.service";
import { LocationRepoLive } from "./modules/location/location.repo";
import { LocationServiceLive } from "./modules/location/location.service";
import { NotificationRepoLive } from "./modules/notification/notification.repo";
import { NotificationServiceLive } from "./modules/notification/notification.service";
import { OfferingRepoLive } from "./modules/offering/offering.repo";
import { OfferingServiceLive } from "./modules/offering/offering.service";
import { PatientRepoLive } from "./modules/patient/patient.repo";
import { PatientServiceLive } from "./modules/patient/patient.service";
import { PatientSearchRepoLive } from "./modules/patient/search/search.repo";
import { PatientSearchServiceLive } from "./modules/patient/search/search.service";
import { ProfileRepoLive } from "./modules/profile/profile.repo";
import { ProfileServiceLive } from "./modules/profile/profile.service";
import { PayoutRepoLive } from "./modules/payout/payout.repo";
import { PayoutServiceLive } from "./modules/payout/payout.service";
import { QualificationRepoLive } from "./modules/qualification/qualification.repo";
import { QualificationServiceLive } from "./modules/qualification/qualification.service";
import { ReferenceRepoLive } from "./modules/reference/reference.repo";
import { ReferenceServiceLive } from "./modules/reference/reference.service";
import { ReviewRepoLive } from "./modules/review/review.repo";
import { ReviewServiceLive } from "./modules/review/review.service";
import { PractitionerRepoLive } from "./modules/practitioner/practitioner.repo";
import { PractitionerServiceLive } from "./modules/practitioner/practitioner.service";
import { PractitionerSearchRepoLive } from "./modules/practitioner/search/search.repo";
import { PractitionerSearchServiceLive } from "./modules/practitioner/search/search.service";

/** Swappable external infra. Real drivers when serving; fakes only under test. */
export type InfraLayers = {
  readonly email: Layer.Layer<EmailSender, unknown, never>;
  readonly storage: Layer.Layer<FileStorage, unknown, never>;
  readonly scanner: Layer.Layer<FileScanner, unknown, never>;
  readonly geocoder: Layer.Layer<Geocoder, unknown, never>;
};

/**
 * In-memory fakes — for automated tests ONLY (the API harness builds its own).
 * Not used by any running server: local dev talks to real S3/Resend (LocalStack
 * + a personal Resend account), so the code path matches production exactly.
 */
export const fakeInfra: InfraLayers = {
  email: EmailSenderConsoleLive,
  storage: FileStorageFakeLive,
  scanner: FileScannerCleanLive,
  geocoder: GeocoderFakeLive,
};

/**
 * Assemble the full application layer over a given database layer + infra choice.
 * This is the SINGLE place the layer graph is wired (docs/conventions.md).
 */
export const makeAppLayer = (database: typeof DatabaseLive, infra: InfraLayers) => {
  const idGen = IdGeneratorLive;
  const crypto = CryptoLive;

  const profileRepo = ProfileRepoLive.pipe(Layer.provide(database));
  const patientRepo = PatientRepoLive.pipe(Layer.provide(database));
  const practitionerRepo = PractitionerRepoLive.pipe(Layer.provide(database));
  const dependentRepo = DependentRepoLive.pipe(Layer.provide(database));
  const notificationRepo = NotificationRepoLive.pipe(Layer.provide(database));
  const adminRepo = AdminRepoLive.pipe(Layer.provide(database));
  const invitationRepo = InvitationRepoLive.pipe(Layer.provide(database));
  const availabilityRepo = AvailabilityRepoLive.pipe(Layer.provide(database));
  const referenceRepo = ReferenceRepoLive.pipe(Layer.provide(database));
  const qualificationRepo = QualificationRepoLive.pipe(Layer.provide(database));
  const locationRepo = LocationRepoLive.pipe(Layer.provide(database));
  const offeringRepo = OfferingRepoLive.pipe(Layer.provide(database));
  const payoutRepo = PayoutRepoLive.pipe(Layer.provide(database));
  const reviewRepo = ReviewRepoLive.pipe(Layer.provide(database));

  const reference = ReferenceServiceLive.pipe(Layer.provide(referenceRepo));
  const qualification = QualificationServiceLive.pipe(
    Layer.provide(Layer.mergeAll(qualificationRepo, practitionerRepo, idGen)),
  );
  const location = LocationServiceLive.pipe(
    Layer.provide(Layer.mergeAll(locationRepo, practitionerRepo, idGen, infra.geocoder, database)),
  );
  const offering = OfferingServiceLive.pipe(
    Layer.provide(Layer.mergeAll(offeringRepo, practitionerRepo, idGen, database)),
  );
  const payout = PayoutServiceLive.pipe(
    Layer.provide(Layer.mergeAll(payoutRepo, practitionerRepo, idGen, crypto, database)),
  );
  const availability = AvailabilityServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(availabilityRepo, practitionerRepo, locationRepo, idGen, database),
    ),
  );

  const profile = ProfileServiceLive.pipe(
    Layer.provide(Layer.mergeAll(profileRepo, idGen, infra.storage)),
  );
  const notification = NotificationServiceLive.pipe(
    Layer.provide(Layer.mergeAll(notificationRepo, idGen)),
  );
  // `database` is also given to services that run multi-write transactions
  // (SqlClient.withTransaction) — the repos + service then share one SqlClient.
  const patient = PatientServiceLive.pipe(
    Layer.provide(Layer.mergeAll(patientRepo, profileRepo, idGen, database)),
  );
  const patientSearchRepo = PatientSearchRepoLive.pipe(Layer.provide(database));
  const patientSearch = PatientSearchServiceLive.pipe(Layer.provide(patientSearchRepo));
  const practitioner = PractitionerServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        practitionerRepo,
        profileRepo,
        availability,
        referenceRepo,
        reference,
        qualificationRepo,
        locationRepo,
        offeringRepo,
        reviewRepo,
        idGen,
        crypto,
        infra.scanner,
        infra.storage,
        infra.geocoder,
        database,
      ),
    ),
  );
  const practitionerSearchRepo = PractitionerSearchRepoLive.pipe(Layer.provide(database));
  const practitionerSearch = PractitionerSearchServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(practitionerSearchRepo, referenceRepo, availability, infra.storage),
    ),
  );
  const admin = AdminServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        practitionerRepo,
        adminRepo,
        idGen,
        crypto,
        infra.storage,
        infra.email,
        database,
      ),
    ),
  );
  const review = ReviewServiceLive.pipe(
    Layer.provide(Layer.mergeAll(reviewRepo, practitionerRepo, idGen, database)),
  );
  const dependent = DependentServiceLive.pipe(Layer.provide(Layer.mergeAll(dependentRepo, idGen)));
  const invitation = InvitationServiceLive.pipe(
    Layer.provide(Layer.mergeAll(invitationRepo, idGen, infra.email, database)),
  );
  const health = HealthLive.pipe(Layer.provide(database));

  return Layer.mergeAll(
    profile,
    notification,
    patient,
    patientSearch,
    practitioner,
    practitionerSearch,
    admin,
    review,
    availability,
    reference,
    qualification,
    location,
    offering,
    payout,
    dependent,
    invitation,
    health,
    RateLimiterInMemoryLive,
    LoggerLive,
  );
};

/**
 * Infra for a running server. Storage (S3) and email (Resend) are the SAME real
 * drivers in every environment — local just points them at LocalStack and a
 * personal Resend account via env (AWS_ENDPOINT_URL_S3 / RESEND_API_KEY). Only
 * the malware scanner differs: GuardDuty runs in deployed environments, but it
 * can't be emulated by LocalStack, so local falls back to the clean scanner.
 */
export const infraFor = (appEnv: string): InfraLayers => ({
  email: EmailSenderResendLive,
  storage: FileStorageS3Live,
  scanner: appEnv === "prod" || appEnv === "staging" ? FileScannerS3Live : FileScannerCleanLive,
  geocoder: appEnv === "prod" || appEnv === "staging" ? GeocoderNominatimLive : GeocoderFakeLive,
});

/** Build the one application runtime (production entry). */
export const makeRuntime = (appEnv: string) =>
  ManagedRuntime.make(makeAppLayer(DatabaseLive, infraFor(appEnv)));
