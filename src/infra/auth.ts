import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, emailOTP, openAPI } from "better-auth/plugins";
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Config, Context, Effect, Redacted } from "effect";
import * as authSchema from "@/db/schema/auth";
import { user } from "@/db/schema/auth";
import { caregiverLink } from "@/db/schema/caregiver-link";
import { dependent } from "@/db/schema/dependent";
import { practitionerProfile } from "@/db/schema/practitioner-profile";
import type { EmailClient } from "./email";
import { renderEmail } from "./email-render";
import type { Locale } from "./i18n";

/** Roles a user may hold. A user can hold several (comma-separated in storage). */
export const ROLES = ["patient", "doctor", "nurse", "dependent", "admin"] as const;
export type Role = (typeof ROLES)[number];
const ROLE_SET: ReadonlySet<string> = new Set(ROLES);
const PRACTITIONER_ROLES = new Set<Role>(["doctor", "nurse"]);

export const parseRoles = (raw: string | null | undefined): ReadonlyArray<Role> =>
  (raw ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter((r): r is Role => ROLE_SET.has(r));

export const serializeRoles = (roles: Iterable<Role>): string => [...new Set(roles)].join(",");
export const isPractitionerRole = (role: Role): boolean => PRACTITIONER_ROLES.has(role);

export type AuthOptions = {
  readonly databaseUrl: string;
  readonly secret: string;
  readonly baseURL: string;
  readonly defaultLocale: Locale;
  readonly emailClient: EmailClient;
  readonly trustedOrigins?: ReadonlyArray<string>;
  /** When set, uploaded files are deleted from S3 before account deletion; DB rows cascade. */
  readonly s3?: { readonly bucket: string; readonly region: string };
  /**
   * Force better-auth's own rate limiter on/off. Left undefined it follows
   * better-auth's default (on in production). Tests set `true` to assert the
   * OTP send budget deterministically.
   */
  readonly rateLimit?: { readonly enabled: boolean };
};

// OTP *send* endpoints get a strict per-IP budget (3 / 15 min) so a client can't
// spam verification/reset/change codes. Verify-attempt capping is emailOTP's own
// `allowedAttempts` default. better-auth keys these by IP + path (not by email).
const OTP_SEND_WINDOW_SECONDS = 15 * 60;
const OTP_SEND_MAX = 3;
const otpSendRules = {
  "/email-otp/send-verification-otp": { window: OTP_SEND_WINDOW_SECONDS, max: OTP_SEND_MAX },
  "/email-otp/request-password-reset": { window: OTP_SEND_WINDOW_SECONDS, max: OTP_SEND_MAX },
  "/email-otp/request-email-change": { window: OTP_SEND_WINDOW_SECONDS, max: OTP_SEND_MAX },
};

/**
 * Build a better-auth instance. better-auth is Promise-based and owns its own
 * tables + node-postgres pool (separate from the Effect SQL pool). Quarantined
 * behind this factory; the app consumes it at the HTTP edge (createApp).
 *
 * - `role` is a NON-input field (clients can't self-assign; defaults to patient;
 *   our server code grants doctor/nurse/admin).
 * - `locale` is captured at signup and used for async (email) localization.
 * - emailOTP (6-digit, 5-min) is auto-sent on signup and drives password reset;
 *   the OTP email is localized from the recipient's stored locale.
 */
export const makeAuth = (options: AuthOptions) => {
  const db = drizzle(options.databaseUrl, { schema: authSchema });

  const lookupLocale = async (email: string): Promise<Locale> => {
    const rows = await db
      .select({ locale: user.locale })
      .from(user)
      .where(eq(user.email, email))
      .limit(1);
    const value = rows[0]?.locale;
    return value === "en" || value === "fr" ? value : options.defaultLocale;
  };

  const rateLimit =
    options.rateLimit === undefined
      ? { customRules: otpSendRules }
      : { enabled: options.rateLimit.enabled, customRules: otpSendRules };

  const instance = betterAuth({
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      // Resetting the password invalidates every other session (§3.2).
      revokeSessionsOnPasswordReset: true,
    },
    secret: options.secret,
    baseURL: options.baseURL,
    trustedOrigins: options.trustedOrigins ? [...options.trustedOrigins] : undefined,
    rateLimit,
    user: {
      additionalFields: {
        role: { type: "string", required: false, defaultValue: "patient", input: false },
        locale: {
          type: "string",
          required: false,
          defaultValue: options.defaultLocale,
          input: true,
        },
      },
      deleteUser: {
        enabled: true,
        // Profiles, links, and consent audit cascade via FKs. Two things do not
        // and are handled here before the user row goes away: (1) managed
        // dependent person records — the FK points from caregiver_link TO
        // dependent, so a cascaded link never removes the dependent it named;
        // (2) S3 objects, which no FK can reach.
        beforeDelete: async (deleted) => {
          // Managed dependents linked to this caregiver. Hard-delete only those
          // this user solely manages (mirrors unlink's "last caregiver" rule);
          // deleting each dependent cascades its remaining links. Shared
          // dependents survive — their link to this user cascades on user delete.
          const mine = await db
            .select({ id: caregiverLink.managedDependentId })
            .from(caregiverLink)
            .where(
              and(
                eq(caregiverLink.caregiverUserId, deleted.id),
                isNotNull(caregiverLink.managedDependentId),
              ),
            );
          const mineIds = mine.map((r) => r.id).filter((id): id is string => id !== null);
          if (mineIds.length > 0) {
            const shared = await db
              .select({ id: caregiverLink.managedDependentId })
              .from(caregiverLink)
              .where(
                and(
                  ne(caregiverLink.caregiverUserId, deleted.id),
                  inArray(caregiverLink.managedDependentId, mineIds),
                ),
              );
            const sharedIds = new Set(shared.map((r) => r.id));
            const soleIds = mineIds.filter((id) => !sharedIds.has(id));
            if (soleIds.length > 0) {
              await db.delete(dependent).where(inArray(dependent.id, soleIds));
            }
          }

          if (options.s3 === undefined) return;
          const rows = await db
            .select({
              cmc: practitionerProfile.cmcCertificateFileKey,
              nic: practitionerProfile.nicFileKey,
              photo: practitionerProfile.profilePhotoFileKey,
            })
            .from(practitionerProfile)
            .where(eq(practitionerProfile.userId, deleted.id))
            .limit(1);
          const first = rows[0];
          if (first === undefined) return;
          const keys = [first.cmc, first.nic, first.photo].filter((k): k is string => k !== null);
          if (keys.length === 0) return;
          const client = new S3Client({ region: options.s3.region });
          await client.send(
            new DeleteObjectsCommand({
              Bucket: options.s3.bucket,
              Delete: { Objects: keys.map((Key) => ({ Key })) },
            }),
          );
        },
      },
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 60 * 5,
        sendVerificationOnSignUp: true,
        // Let a signed-in user change their email: an OTP is sent to the new
        // address and confirmed there (we don't require re-verifying the old one).
        changeEmail: { enabled: true },
        sendVerificationOTP: async ({ email, otp, type }) => {
          const locale = await lookupLocale(email);
          const scenario =
            type === "forget-password"
              ? ({ kind: "reset-password", otp } as const)
              : ({ kind: "otp", otp } as const);
          await options.emailClient.send({ to: email, ...renderEmail(scenario, locale) });
        },
      }),
      bearer(),
      openAPI(),
    ],
  });

  return { instance, db, close: () => db.$client.end() };
};

export type AuthInstance = ReturnType<typeof makeAuth>["instance"];

/** Read auth config from the environment (via Effect Config — never process.env). */
export const loadAuthOptions = Effect.gen(function* () {
  const databaseUrl = yield* Config.redacted("DATABASE_URL");
  const secret = yield* Config.redacted("BETTER_AUTH_SECRET").pipe(
    Config.withDefault(Redacted.make("dev-only-insecure-secret-change-in-production-000")),
  );
  const baseURL = yield* Config.string("BETTER_AUTH_URL").pipe(
    Config.withDefault("http://localhost:3000"),
  );
  return {
    databaseUrl: Redacted.value(databaseUrl),
    secret: Redacted.value(secret),
    baseURL,
  };
});

/** The authenticated user for the current request. */
export type AuthUser = {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly roles: ReadonlyArray<Role>;
  readonly locale: Locale;
};

/**
 * The current authenticated user as an Effect service, provided PER-REQUEST from
 * the session (src/http/app.ts middleware) — not part of the app runtime. Routes
 * that require auth carry `CurrentUser` in their `R` channel; an unauthenticated
 * request never provides it (the handler 401s first).
 */
export class CurrentUser extends Context.Tag("CurrentUser")<CurrentUser, AuthUser>() {}
