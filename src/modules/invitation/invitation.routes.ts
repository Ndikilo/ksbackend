import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { Effect } from "effect";
import type { CaregiverLinkView } from "@/domain/invitation/invitation";
import type { AppEnv, AppRuntime } from "@/http/app-env";
import { makeRun } from "@/http/run";
import { CursorQuery, ErrorResponse } from "@/http/schemas";
import { CurrentUser } from "@/infra/auth";
import {
  InviteBody,
  LinkIdParam,
  LinkResponse,
  LinksPage,
  TokenParam,
  UserSearchQuery,
  UserSearchResponse,
} from "./invitation.contract";
import { InvitationService } from "./invitation.service";

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } } });

const toView = (v: CaregiverLinkView) => ({
  id: v.id,
  caregiverUserId: v.caregiverUserId,
  subjectUserId: v.subjectUserId,
  inviteIdentifier: v.inviteIdentifier,
  relationship: v.relationship,
  status: v.status,
  direction: v.direction,
});

const invite = createRoute({
  method: "post",
  path: "/v1/dependents/invitations",
  tags: ["Dependents"],
  summary: "Invite an account-holder to be linked as a dependent",
  description: [
    "Link an EXISTING account-holder (not a managed dependent) as your dependent. Creates a",
    "`pending` caregiver link and emails an invitation token to `inviteeEmail`; the invitee",
    "activates it via `POST /v1/invitations/{token}/accept`. The token is NEVER returned here —",
    "only emailed. You cannot invite yourself (`422`), and a duplicate pending invite to the same",
    "person is rejected (`409`). To add someone who has no account, use `POST /v1/dependents`.",
  ].join(" "),
  request: { body: jsonBody(InviteBody) },
  responses: {
    201: {
      ...jsonBody(LinkResponse),
      description: "The pending caregiver link (`status: pending`, `direction: sent`).",
    },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    409: {
      ...jsonBody(ErrorResponse),
      description: "A pending invite to this person already exists.",
    },
    422: {
      ...jsonBody(ErrorResponse),
      description: "Validation failed, or you tried to invite yourself.",
    },
  },
});

const listMine = createRoute({
  method: "get",
  path: "/v1/me/invitations",
  tags: ["Dependents"],
  summary: "Caregiver links sent by / addressed to the current user",
  description: [
    "Cursor-paginated list of every caregiver link the user is a party to — both invites they",
    "SENT (`direction: sent`) and invites addressed to them (`direction: received`), including",
    "pending invites matched by their email. Use it to render the invitee's inbox and the",
    "caregiver's outbox. Tokens are never included; accept/decline via the link emailed to you.",
  ].join(" "),
  request: { query: CursorQuery },
  responses: {
    200: { ...jsonBody(LinksPage), description: "A page of caregiver links involving the user." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    422: { ...jsonBody(ErrorResponse), description: "The pagination cursor was malformed." },
  },
});

const accept = createRoute({
  method: "post",
  path: "/v1/invitations/{token}/accept",
  tags: ["Dependents"],
  summary: "Accept a caregiver invitation (activates the link)",
  description: [
    "Consume the token from an invitation email to activate the link, becoming the caregiver's",
    "dependent (the `subject`). The signed-in user's email must match the address the invite was",
    "sent to, otherwise `403`. Terminal states can't be re-accepted: an expired or already-answered",
    "invite returns `409`, and an unknown token `404`.",
  ].join(" "),
  request: { params: TokenParam },
  responses: {
    200: { ...jsonBody(LinkResponse), description: "The now-active link (`status: active`)." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: {
      ...jsonBody(ErrorResponse),
      description: "This invite was addressed to a different user.",
    },
    404: { ...jsonBody(ErrorResponse), description: "No invitation matches this token." },
    409: {
      ...jsonBody(ErrorResponse),
      description: "The invite has expired or was already accepted/declined.",
    },
  },
});

const decline = createRoute({
  method: "post",
  path: "/v1/invitations/{token}/decline",
  tags: ["Dependents"],
  summary: "Decline a caregiver invitation",
  description: [
    "Reject an invitation you received. This is terminal — the link moves to `declined` and cannot",
    "later be accepted. Same guards as accept: the signed-in user's email must match the invited",
    "address (`403`), the token must be known (`404`), and an expired or already-answered invite",
    "returns `409`.",
  ].join(" "),
  request: { params: TokenParam },
  responses: {
    204: { description: "The invitation was declined (no body)." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    403: {
      ...jsonBody(ErrorResponse),
      description: "This invite was addressed to a different user.",
    },
    404: { ...jsonBody(ErrorResponse), description: "No invitation matches this token." },
    409: {
      ...jsonBody(ErrorResponse),
      description: "The invite has expired or was already accepted/declined.",
    },
  },
});

const unlink = createRoute({
  method: "delete",
  path: "/v1/dependents/links/{id}",
  tags: ["Dependents"],
  summary: "Revoke a caregiver link (either party)",
  description: [
    "Tear down a caregiver link by its id. EITHER party may revoke — the caregiver or the linked",
    "dependent — and it applies whether the link is still `pending` or already `active`. If the",
    "caller is not a party to the link they get `404` (never `403`), so links they aren't part of",
    "stay invisible.",
  ].join(" "),
  request: { params: LinkIdParam },
  responses: {
    204: { description: "The link was revoked (no body)." },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    404: {
      ...jsonBody(ErrorResponse),
      description: "No such link, or the caller is not a party to it.",
    },
  },
});

const search = createRoute({
  method: "get",
  path: "/v1/users/search",
  tags: ["Dependents"],
  summary: "Whether an account exists for an exact email (for linking)",
  description: [
    "Existence check for the invite UI: given an EXACT email, tells you only whether an account",
    "exists so the client can decide between inviting an account-holder and creating a managed",
    "dependent. Deliberately returns nothing but `{ exists }` — no name or id — to avoid user",
    "enumeration and PII leakage; identities become mutually visible only after an invite is",
    "accepted.",
  ].join(" "),
  request: { query: UserSearchQuery },
  responses: {
    200: {
      ...jsonBody(UserSearchResponse),
      description: "Whether an account exists for that exact email.",
    },
    401: { ...jsonBody(ErrorResponse), description: "No valid session." },
    422: {
      ...jsonBody(ErrorResponse),
      description: "The email query parameter was missing or malformed.",
    },
  },
});

export const registerInvitationRoutes = (app: OpenAPIHono<AppEnv>, runtime: AppRuntime): void => {
  const { runAuth } = makeRun(runtime);

  app.openapi(invite, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* InvitationService;
        const body = c.req.valid("json");
        const link = yield* service.invite({
          caregiverUserId: user.id,
          caregiverEmail: user.email,
          inviteeEmail: body.inviteeEmail,
          relationship: body.relationship,
        });
        return c.json(toView(link), 201);
      }),
    ),
  );

  app.openapi(listMine, (c) => {
    const { limit, cursor } = c.req.valid("query");
    return runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* InvitationService;
        const page = yield* service.listMine(user.id, user.email, limit, cursor);
        return c.json({ data: page.data.map(toView), meta: page.meta }, 200);
      }),
    );
  });

  app.openapi(accept, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* InvitationService;
        const link = yield* service.accept(user.id, user.email, c.req.valid("param").token);
        return c.json(toView(link), 200);
      }),
    ),
  );

  app.openapi(decline, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* InvitationService;
        yield* service.decline(user.id, user.email, c.req.valid("param").token);
        return c.body(null, 204);
      }),
    ),
  );

  app.openapi(unlink, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const service = yield* InvitationService;
        yield* service.revoke(user.id, c.req.valid("param").id);
        return c.body(null, 204);
      }),
    ),
  );

  app.openapi(search, (c) =>
    runAuth(
      c,
      Effect.gen(function* () {
        const service = yield* InvitationService;
        const exists = yield* service.searchUser(c.req.valid("query").email);
        return c.json({ exists }, 200);
      }),
    ),
  );
};
