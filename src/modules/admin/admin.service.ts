import { SqlClient, SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";
import type { AdminScope } from "@/domain/admin/admin";
import type { Practitioner } from "@/domain/practitioner/practitioner";
import {
  Forbidden,
  NotFound,
  ValidationFailed,
  VerificationStateInvalid,
} from "@/domain/shared/errors";
import { CurrentUser } from "@/infra/auth";
import { requireRole } from "@/infra/authz";
import { Crypto, type DecryptError } from "@/infra/crypto";
import { EmailSender, type EmailError } from "@/infra/email";
import { renderEmail } from "@/infra/email-render";
import { IdGenerator } from "@/infra/ids";
import { FileStorage, type StorageError } from "@/infra/storage";
import { decodeCursor, encodeCursor } from "@/lib/cursor";
import { PractitionerRepo } from "@/modules/practitioner/practitioner.repo";
import { AdminRepo } from "./admin.repo";

// Verification actions require an admin with at least reviewer scope.
const REVIEWER_SCOPES: ReadonlyArray<AdminScope> = ["super_admin", "verification_reviewer"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type VerificationPage = {
  readonly data: ReadonlyArray<Practitioner>;
  readonly meta: {
    readonly count: number;
    readonly limit: number;
    readonly nextCursor: string | null;
    readonly hasNextPage: boolean;
  };
};

export type VerificationDetail = {
  readonly practitioner: Practitioner;
  readonly cmcRegistrationNumber: string;
  readonly nicNumber: string;
  readonly documents: {
    readonly cmcCertificateUrl: string | null;
    readonly nicUrl: string | null;
    readonly profilePhotoUrl: string | null;
  };
};

export interface AdminServiceService {
  readonly listPending: (
    limit: number,
    cursor: string | undefined,
  ) => Effect.Effect<
    VerificationPage,
    Forbidden | ValidationFailed | SqlError.SqlError,
    CurrentUser
  >;
  readonly getDetail: (
    id: string,
  ) => Effect.Effect<
    VerificationDetail,
    Forbidden | NotFound | DecryptError | StorageError | SqlError.SqlError,
    CurrentUser
  >;
  readonly approve: (
    id: string,
  ) => Effect.Effect<
    Practitioner,
    Forbidden | NotFound | VerificationStateInvalid | SqlError.SqlError,
    CurrentUser
  >;
  readonly reject: (
    id: string,
    reason: string,
  ) => Effect.Effect<
    Practitioner,
    Forbidden | NotFound | VerificationStateInvalid | SqlError.SqlError,
    CurrentUser
  >;
}

export class AdminService extends Context.Tag("AdminService")<
  AdminService,
  AdminServiceService
>() {}

export const AdminServiceLive = Layer.effect(
  AdminService,
  Effect.gen(function* () {
    const repo = yield* PractitionerRepo;
    const adminRepo = yield* AdminRepo;
    const crypto = yield* Crypto;
    const storage = yield* FileStorage;
    const email = yield* EmailSender;
    const ids = yield* IdGenerator;
    const sql = yield* SqlClient.SqlClient;

    // Gate an action on the caller's admin scope (implies the admin role).
    const requireScope = (allowed: ReadonlyArray<AdminScope>) =>
      Effect.gen(function* () {
        yield* requireRole("admin");
        const current = yield* CurrentUser;
        const scope = yield* adminRepo.findScope(current.id);
        if (scope === undefined || !allowed.includes(scope)) {
          return yield* Effect.fail(new Forbidden({ reason: "insufficient admin scope" }));
        }
      });

    const presignMaybe = (key: string | null) =>
      key === null ? Effect.succeed(null) : storage.presignDownload(key);

    const notify = (
      practitionerId: string,
      scenario: Parameters<typeof renderEmail>[0],
    ): Effect.Effect<void, EmailError | SqlError.SqlError> =>
      repo
        .findContact(practitionerId)
        .pipe(
          Effect.flatMap((contact) =>
            contact === undefined
              ? Effect.void
              : email.send({ to: contact.email, ...renderEmail(scenario, contact.locale) }),
          ),
        );

    const decideAndReview = (
      id: string,
      decision: "approved" | "rejected",
      reason: string | null,
    ) =>
      Effect.gen(function* () {
        yield* requireScope(REVIEWER_SCOPES);
        const reviewer = yield* CurrentUser;
        const found = yield* repo.findById(id);
        if (found === undefined) {
          return yield* Effect.fail(new NotFound({ resource: "Practitioner", id }));
        }
        // State-machine guard: only a profile awaiting review can be decided.
        // Without this an admin could verify an `incomplete` profile — one that
        // registered but never submitted credentials — or re-decide a terminal one.
        if (found.verificationStatus !== "pending_verification") {
          return yield* Effect.fail(
            new VerificationStateInvalid({ current: found.verificationStatus }),
          );
        }
        const now = new Date(yield* Clock.currentTimeMillis);
        const reviewId = yield* ids.next;
        // Status change + audit row are one atomic unit: a profile must never
        // flip to verified/rejected without its verification_review record.
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* repo.setStatus(id, decision === "approved" ? "verified" : "rejected", now);
            yield* repo.addReview({
              id: reviewId,
              practitionerProfileId: id,
              reviewerUserId: reviewer.id,
              decision,
              reason,
            });
          }),
        );
        // Notification is a post-commit, best-effort side effect: a mail hiccup
        // must not fail (and prompt a retry of) an approval that's already durable.
        yield* notify(
          id,
          decision === "approved"
            ? { kind: "verification-approved" }
            : { kind: "verification-rejected", reason: reason ?? "" },
        ).pipe(
          Effect.catchAll((cause) => Effect.logWarning("verification notification failed", cause)),
        );
        return {
          ...found,
          verificationStatus: decision === "approved" ? "verified" : "rejected",
        } as const;
      });

    return {
      listPending: (limit, cursor) =>
        Effect.gen(function* () {
          yield* requireScope(REVIEWER_SCOPES);
          let beforeId: string | undefined;
          if (cursor !== undefined) {
            const decoded = decodeCursor(cursor);
            if (!UUID_RE.test(decoded)) {
              return yield* Effect.fail(
                new ValidationFailed({ issues: [{ path: "cursor", message: "Invalid cursor." }] }),
              );
            }
            beforeId = decoded;
          }
          const rows = yield* repo.listByStatus("pending_verification", limit + 1, beforeId);
          const hasNextPage = rows.length > limit;
          const data = hasNextPage ? rows.slice(0, limit) : rows;
          const last = data.at(-1);
          return {
            data,
            meta: {
              count: data.length,
              limit,
              nextCursor: hasNextPage && last ? encodeCursor(last.id) : null,
              hasNextPage,
            },
          };
        }),

      getDetail: (id) =>
        Effect.gen(function* () {
          yield* requireScope(REVIEWER_SCOPES);
          const found = yield* repo.findByIdWithSecrets(id);
          if (found === undefined) {
            return yield* Effect.fail(new NotFound({ resource: "Practitioner", id }));
          }
          const cmcRegistrationNumber =
            found.cmcNumberEncrypted === null
              ? ""
              : yield* crypto.decrypt(found.cmcNumberEncrypted);
          const nicNumber =
            found.nicNumberEncrypted === null
              ? ""
              : yield* crypto.decrypt(found.nicNumberEncrypted);
          const [cmcCertificateUrl, nicUrl, profilePhotoUrl] = yield* Effect.all(
            [
              presignMaybe(found.practitioner.cmcCertificateFileKey),
              presignMaybe(found.practitioner.nicFileKey),
              presignMaybe(found.practitioner.profilePhotoFileKey),
            ],
            { concurrency: "unbounded" },
          );
          return {
            practitioner: found.practitioner,
            cmcRegistrationNumber,
            nicNumber,
            documents: { cmcCertificateUrl, nicUrl, profilePhotoUrl },
          };
        }),

      approve: (id) => decideAndReview(id, "approved", null),
      reject: (id, reason) => decideAndReview(id, "rejected", reason),
    } satisfies AdminServiceService;
  }),
);
