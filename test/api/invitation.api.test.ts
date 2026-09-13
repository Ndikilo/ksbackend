import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user } from "@/db/schema/auth";
import { caregiverLink } from "@/db/schema/caregiver-link";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and immediately assert on those shapes.
const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Linked (account) dependents: invite -> accept -> active, with the token emailed
// to the invitee, symmetric revoke, and exact-match user search.
describe("caregiver invitations API (real DB)", () => {
  let harness: TestHarness;
  let caregiver: string;

  const tokenFor = (email: string): string => {
    const msg = harness.sent.toReversed().find((m) => m.to === email && /accept/i.test(m.html));
    const match = msg?.html.match(UUID);
    if (match === null || match === undefined) throw new Error(`no invite token for ${email}`);
    return match[0];
  };

  beforeAll(async () => {
    harness = await createTestHarness();
    caregiver = await harness.signUpAndVerify(
      "caregiver@example.com",
      "password12345",
      "Care Giver",
    );
  });

  afterAll(() => harness.dispose());

  it("invite -> emailed token -> accept -> active link, visible to both parties", async () => {
    const inviteeEmail = "linked-dep@example.com";
    const inviteeCookie = await harness.signUpAndVerify(
      inviteeEmail,
      "password12345",
      "Linked Dep",
    );

    const invited = await harness.post(
      "/v1/dependents/invitations",
      { inviteeEmail, relationship: "parent" },
      caregiver,
    );
    expect(invited.status).toBe(201);
    const link = await json<{ id: string; status: string; direction: string }>(invited);
    expect(link.status).toBe("pending");
    expect(link.direction).toBe("sent");

    const token = tokenFor(inviteeEmail);
    const accepted = await harness.post(`/v1/invitations/${token}/accept`, {}, inviteeCookie);
    expect(accepted.status).toBe(200);
    const active = await json<{ status: string; subjectUserId: string | null }>(accepted);
    expect(active.status).toBe("active");
    expect(active.subjectUserId).not.toBeNull();

    // Caregiver sees it as sent+active; invitee sees it as received.
    const mine = await json<{
      data: ReadonlyArray<{ id: string; direction: string; status: string }>;
    }>(await harness.app.request("/v1/me/invitations", { headers: { cookie: caregiver } }));
    expect(
      mine.data.some((l) => l.id === link.id && l.direction === "sent" && l.status === "active"),
    ).toBe(true);
    const theirs = await json<{ data: ReadonlyArray<{ id: string; direction: string }> }>(
      await harness.app.request("/v1/me/invitations", { headers: { cookie: inviteeCookie } }),
    );
    expect(theirs.data.some((l) => l.id === link.id && l.direction === "received")).toBe(true);

    // Either party can revoke.
    expect(
      (
        await harness.app.request(`/v1/dependents/links/${link.id}`, {
          method: "DELETE",
          headers: { cookie: inviteeCookie },
        })
      ).status,
    ).toBe(204);
  });

  it("rejects inviting yourself (422) and duplicate invites (409)", async () => {
    expect(
      (
        await harness.post(
          "/v1/dependents/invitations",
          { inviteeEmail: "caregiver@example.com", relationship: "other" },
          caregiver,
        )
      ).status,
    ).toBe(422);

    const dup = { inviteeEmail: "dup-invitee@example.com", relationship: "sibling" as const };
    expect((await harness.post("/v1/dependents/invitations", dup, caregiver)).status).toBe(201);
    expect((await harness.post("/v1/dependents/invitations", dup, caregiver)).status).toBe(409);
  });

  it("accept: 404 for an unknown token, 403 when addressed to another user", async () => {
    expect(
      (await harness.post(`/v1/invitations/${crypto.randomUUID()}/accept`, {}, caregiver)).status,
    ).toBe(404);

    const inviteeEmail = "wrong-user-dep@example.com";
    await harness.post(
      "/v1/dependents/invitations",
      { inviteeEmail, relationship: "child" },
      caregiver,
    );
    const token = tokenFor(inviteeEmail);
    // A different user (the caregiver) tries to accept an invite addressed elsewhere.
    expect((await harness.post(`/v1/invitations/${token}/accept`, {}, caregiver)).status).toBe(403);
  });

  it("decline: marks the link declined and blocks a later accept", async () => {
    const inviteeEmail = "decliner@example.com";
    const inviteeCookie = await harness.signUpAndVerify(inviteeEmail, "password12345", "Dec Liner");
    await harness.post(
      "/v1/dependents/invitations",
      { inviteeEmail, relationship: "parent" },
      caregiver,
    );
    const token = tokenFor(inviteeEmail);

    expect((await harness.post(`/v1/invitations/${token}/decline`, {}, inviteeCookie)).status).toBe(
      204,
    );
    // A declined invitation is terminal — accepting it now conflicts.
    expect((await harness.post(`/v1/invitations/${token}/accept`, {}, inviteeCookie)).status).toBe(
      409,
    );
  });

  it("accept: rejects an expired invitation with 409", async () => {
    const inviteeEmail = "expired-dep@example.com";
    const inviteeCookie = await harness.signUpAndVerify(inviteeEmail, "password12345", "Exp Ired");
    const caregiverId =
      (
        await harness.db
          .select({ id: user.id })
          .from(user)
          .where(eq(user.email, "caregiver@example.com"))
      )[0]?.id ?? "";

    const token = crypto.randomUUID();
    await harness.db.insert(caregiverLink).values({
      id: crypto.randomUUID(),
      caregiverUserId: caregiverId,
      inviteIdentifier: inviteeEmail,
      inviteToken: token,
      relationship: "parent",
      status: "pending",
      expiresAt: new Date("2000-01-02T00:00:00.000Z"),
      invitedAt: new Date("2000-01-01T00:00:00.000Z"),
    });

    expect((await harness.post(`/v1/invitations/${token}/accept`, {}, inviteeCookie)).status).toBe(
      409,
    );
  });

  it("paginates /v1/me/invitations with an opaque cursor", async () => {
    // A dedicated caregiver so the page counts are independent of other tests.
    const pager = await harness.signUpAndVerify("pager@example.com", "password12345", "Pag Er");
    for (const e of ["pg-a@example.com", "pg-b@example.com", "pg-c@example.com"]) {
      expect(
        (
          await harness.post(
            "/v1/dependents/invitations",
            { inviteeEmail: e, relationship: "child" },
            pager,
          )
        ).status,
      ).toBe(201);
    }

    const page1 = await json<{
      data: ReadonlyArray<{ id: string }>;
      meta: { count: number; hasNextPage: boolean; nextCursor: string | null };
    }>(await harness.app.request("/v1/me/invitations?limit=2", { headers: { cookie: pager } }));
    expect(page1.data.length).toBe(2);
    expect(page1.meta.hasNextPage).toBe(true);
    expect(page1.meta.nextCursor).not.toBeNull();

    const page2 = await json<{
      data: ReadonlyArray<{ id: string }>;
      meta: { hasNextPage: boolean };
    }>(
      await harness.app.request(`/v1/me/invitations?limit=2&cursor=${page1.meta.nextCursor}`, {
        headers: { cookie: pager },
      }),
    );
    expect(page2.data.length).toBe(1);
    expect(page2.meta.hasNextPage).toBe(false);
    // No overlap between pages.
    const ids1 = new Set(page1.data.map((l) => l.id));
    expect(page2.data.every((l) => !ids1.has(l.id))).toBe(true);

    // A malformed cursor is a 422, not a 500.
    expect(
      (
        await harness.app.request("/v1/me/invitations?cursor=not-a-cursor", {
          headers: { cookie: pager },
        })
      ).status,
    ).toBe(422);
  });

  it("user search: reports existence only (no PII)", async () => {
    const found = await json<{ exists: boolean }>(
      await harness.app.request("/v1/users/search?email=linked-dep@example.com", {
        headers: { cookie: caregiver },
      }),
    );
    expect(found.exists).toBe(true);

    const miss = await json<{ exists: boolean }>(
      await harness.app.request("/v1/users/search?email=nobody@example.com", {
        headers: { cookie: caregiver },
      }),
    );
    expect(miss.exists).toBe(false);
  });
});
