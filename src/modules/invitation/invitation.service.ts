import { SqlClient, SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";
import type { Relationship } from "@/domain/dependent/dependent";
import type { CaregiverLinkPage, CaregiverLinkView } from "@/domain/invitation/invitation";
import { Conflict, Forbidden, NotFound, ValidationFailed } from "@/domain/shared/errors";
import { EmailSender } from "@/infra/email";
import { renderEmail } from "@/infra/email-render";
import { IdGenerator } from "@/infra/ids";
import { decodeCursor, encodeCursor } from "@/lib/cursor";
import { InvitationRepo, type LinkRow } from "./invitation.repo";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const toView = (row: LinkRow, userId: string): CaregiverLinkView => ({
  id: row.id,
  caregiverUserId: row.caregiverUserId,
  subjectUserId: row.subjectUserId,
  inviteIdentifier: row.inviteIdentifier,
  relationship: row.relationship,
  status: row.status,
  direction: row.caregiverUserId === userId ? "sent" : "received",
});

export interface InvitationServiceService {
  readonly invite: (input: {
    readonly caregiverUserId: string;
    readonly caregiverEmail: string;
    readonly inviteeEmail: string;
    readonly relationship: Relationship;
  }) => Effect.Effect<CaregiverLinkView, ValidationFailed | Conflict | SqlError.SqlError>;
  readonly accept: (
    userId: string,
    userEmail: string,
    token: string,
  ) => Effect.Effect<CaregiverLinkView, NotFound | Conflict | Forbidden | SqlError.SqlError>;
  readonly decline: (
    userId: string,
    userEmail: string,
    token: string,
  ) => Effect.Effect<void, NotFound | Conflict | Forbidden | SqlError.SqlError>;
  readonly revoke: (
    userId: string,
    linkId: string,
  ) => Effect.Effect<void, NotFound | SqlError.SqlError>;
  readonly listMine: (
    userId: string,
    email: string,
    limit: number,
    cursor: string | undefined,
  ) => Effect.Effect<CaregiverLinkPage, ValidationFailed | SqlError.SqlError>;
  /** Exact-email existence check for the invite UI — returns no PII. */
  readonly searchUser: (email: string) => Effect.Effect<boolean, SqlError.SqlError>;
}

export class InvitationService extends Context.Tag("InvitationService")<
  InvitationService,
  InvitationServiceService
>() {}

export const InvitationServiceLive = Layer.effect(
  InvitationService,
  Effect.gen(function* () {
    const repo = yield* InvitationRepo;
    const ids = yield* IdGenerator;
    const sql = yield* SqlClient.SqlClient;
    const mailer = yield* EmailSender;

    // Validate a token is a live, pending invitation addressed to this user.
    const pendingForInvitee = (row: LinkRow | undefined, userEmail: string, now: Date) =>
      Effect.gen(function* () {
        if (row === undefined) return yield* Effect.fail(new NotFound({ resource: "Invitation" }));
        // Check ownership BEFORE status/expiry so we never disclose a token's
        // state to someone it wasn't addressed to.
        if (row.inviteIdentifier !== userEmail.toLowerCase()) {
          return yield* Effect.fail(
            new Forbidden({ reason: "invitation addressed to another user" }),
          );
        }
        if (row.status !== "pending") {
          return yield* Effect.fail(
            new Conflict({ resource: "Invitation", reason: "already responded" }),
          );
        }
        if (row.expiresAt !== null && row.expiresAt.getTime() < now.getTime()) {
          return yield* Effect.fail(new Conflict({ resource: "Invitation", reason: "expired" }));
        }
        return row;
      });

    return {
      invite: ({ caregiverUserId, caregiverEmail, inviteeEmail, relationship }) =>
        Effect.gen(function* () {
          const email = inviteeEmail.toLowerCase();
          if (email === caregiverEmail.toLowerCase()) {
            return yield* Effect.fail(
              new ValidationFailed({
                issues: [{ path: "inviteeEmail", message: "You cannot link yourself." }],
              }),
            );
          }
          if (yield* repo.pendingExists(caregiverUserId, email)) {
            return yield* Effect.fail(
              new Conflict({ resource: "Invitation", reason: "already invited" }),
            );
          }
          const linkId = yield* ids.next;
          const auditId = yield* ids.next;
          const token = yield* ids.next;
          const now = new Date(yield* Clock.currentTimeMillis);
          const row = yield* sql.withTransaction(
            Effect.gen(function* () {
              const created = yield* repo.createInvite({
                id: linkId,
                caregiverUserId,
                inviteIdentifier: email,
                relationship,
                token,
                expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
                now,
              });
              yield* repo.audit({
                id: auditId,
                linkId,
                actorUserId: caregiverUserId,
                event: "invited",
              });
              return created;
            }),
          );
          // Post-commit, best-effort: email the invitee the accept token. The
          // invitee's locale is unknown until they have an account, so default fr.
          yield* mailer
            .send({ to: email, ...renderEmail({ kind: "caregiver-invitation", token }, "fr") })
            .pipe(Effect.catchAll((cause) => Effect.logWarning("invite email failed", cause)));
          return toView(row, caregiverUserId);
        }),

      accept: (userId, userEmail, token) =>
        Effect.gen(function* () {
          const now = new Date(yield* Clock.currentTimeMillis);
          const row = yield* repo
            .findByToken(token)
            .pipe(Effect.flatMap((r) => pendingForInvitee(r, userEmail, now)));
          const auditId = yield* ids.next;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* repo.activate(row.id, userId, now);
              yield* repo.audit({
                id: auditId,
                linkId: row.id,
                actorUserId: userId,
                event: "accepted",
              });
            }),
          );
          return { ...toView(row, userId), subjectUserId: userId, status: "active" };
        }),

      decline: (userId, userEmail, token) =>
        Effect.gen(function* () {
          const now = new Date(yield* Clock.currentTimeMillis);
          const row = yield* repo
            .findByToken(token)
            .pipe(Effect.flatMap((r) => pendingForInvitee(r, userEmail, now)));
          const auditId = yield* ids.next;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* repo.setStatus(row.id, "declined", now);
              yield* repo.audit({
                id: auditId,
                linkId: row.id,
                actorUserId: userId,
                event: "declined",
              });
            }),
          );
        }),

      revoke: (userId, linkId) =>
        Effect.gen(function* () {
          const row = yield* repo.findForParty(linkId, userId);
          if (row === undefined)
            return yield* Effect.fail(new NotFound({ resource: "Link", id: linkId }));
          const now = new Date(yield* Clock.currentTimeMillis);
          const auditId = yield* ids.next;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* repo.setStatus(linkId, "revoked", now);
              yield* repo.audit({ id: auditId, linkId, actorUserId: userId, event: "revoked" });
            }),
          );
        }),

      listMine: (userId, email, limit, cursor) =>
        Effect.gen(function* () {
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
          const rows = yield* repo.listForUser(userId, email.toLowerCase(), limit + 1, beforeId);
          const hasNextPage = rows.length > limit;
          const data = (hasNextPage ? rows.slice(0, limit) : rows).map((r) => toView(r, userId));
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

      searchUser: (email) => repo.emailExists(email.toLowerCase()),
    };
  }),
);
