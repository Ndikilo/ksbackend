import type { ManagedRuntime } from "effect";
import type { EvlogVariables } from "evlog/hono";
import type { RequestIdVariables } from "hono/request-id";
import type { AuthUser } from "@/infra/auth";
import type { Health } from "@/infra/health";
import type { Locale } from "@/infra/i18n";
import type { RateLimiter } from "@/infra/rate-limiter";
import type { AdminService } from "@/modules/admin/admin.service";
import type { AvailabilityService } from "@/modules/availability/availability.service";
import type { DependentService } from "@/modules/dependent/dependent.service";
import type { InvitationService } from "@/modules/invitation/invitation.service";
import type { LocationService } from "@/modules/location/location.service";
import type { NotificationService } from "@/modules/notification/notification.service";
import type { OfferingService } from "@/modules/offering/offering.service";
import type { PatientService } from "@/modules/patient/patient.service";
import type { PatientSearchService } from "@/modules/patient/search/search.service";
import type { PractitionerService } from "@/modules/practitioner/practitioner.service";
import type { PractitionerSearchService } from "@/modules/practitioner/search/search.service";
import type { ProfileService } from "@/modules/profile/profile.service";
import type { PayoutService } from "@/modules/payout/payout.service";
import type { QualificationService } from "@/modules/qualification/qualification.service";
import type { ReferenceService } from "@/modules/reference/reference.service";
import type { ReviewService } from "@/modules/review/review.service";

/** Hono context variables available on every request. */
export type AppEnv = {
  Variables: RequestIdVariables &
    EvlogVariables & {
      // Set by the session middleware; null when the request is unauthenticated.
      user: AuthUser | null;
      // Set by the locale middleware from Accept-Language.
      locale: Locale;
    };
};

/** The services the HTTP layer runs through the runtime. */
export type AppServices =
  | Health
  | RateLimiter
  | ProfileService
  | NotificationService
  | PatientService
  | PatientSearchService
  | PractitionerService
  | PractitionerSearchService
  | AdminService
  | ReviewService
  | AvailabilityService
  | DependentService
  | InvitationService
  | ReferenceService
  | QualificationService
  | LocationService
  | OfferingService
  | PayoutService;

/**
 * The application runtime as seen by the HTTP layer. Any runtime that provides
 * `AppServices` satisfies this. `E` is `unknown` because every failure is caught
 * and mapped at the boundary. (Auth is passed to createApp separately — it lives
 * at the edge, not in the runtime.)
 */
export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, unknown>;
