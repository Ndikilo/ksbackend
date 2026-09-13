import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user } from "@/db/schema/auth";
import { caregiverLink } from "@/db/schema/caregiver-link";
import { dependent } from "@/db/schema/dependent";
import { createTestHarness, type TestHarness } from "../support/app-harness";

// SAFETY: API tests call endpoints with known response contracts and immediately assert on those shapes.
const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;

// Dependent CRUD + ownership scoping against a real Postgres.
describe("dependents API (real DB)", () => {
  let harness: TestHarness;
  let ownerCookie: string;

  beforeAll(async () => {
    harness = await createTestHarness();
    ownerCookie = await harness.signUpAndVerify("owner@example.com", "password12345", "Own Er");
  });

  afterAll(() => harness.dispose());

  const newDependent = {
    surname: "Kana",
    givenNames: "Petit",
    dateOfBirth: "2015-03-02",
    sex: "female",
    relationship: "child",
  };

  it("create -> get -> list -> update -> delete -> 404", async () => {
    const created = await harness.post("/v1/dependents", newDependent, ownerCookie);
    expect(created.status).toBe(201);
    const { id } = await json<{ id: string; givenNames: string }>(created);

    const got = await harness.app.request(`/v1/dependents/${id}`, {
      headers: { cookie: ownerCookie },
    });
    expect(got.status).toBe(200);

    const listed = await harness.app.request("/v1/dependents?limit=10", {
      headers: { cookie: ownerCookie },
    });
    expect(listed.status).toBe(200);
    const page = await json<{ data: ReadonlyArray<{ id: string }> }>(listed);
    expect(page.data.some((d) => d.id === id)).toBe(true);

    const updated = await harness.app.request(`/v1/dependents/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ location: "Bamenda" }),
    });
    expect(updated.status).toBe(200);
    expect((await json<{ location: string }>(updated)).location).toBe("Bamenda");

    const deleted = await harness.app.request(`/v1/dependents/${id}`, {
      method: "DELETE",
      headers: { cookie: ownerCookie },
    });
    expect(deleted.status).toBe(204);

    const afterDelete = await harness.app.request(`/v1/dependents/${id}`, {
      headers: { cookie: ownerCookie },
    });
    expect(afterDelete.status).toBe(404);
  });

  it("an empty PATCH body is a no-op that returns the current row (not a 500)", async () => {
    const created = await harness.post("/v1/dependents", newDependent, ownerCookie);
    const { id } = await json<{ id: string }>(created);

    const noop = await harness.app.request(`/v1/dependents/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({}),
    });
    expect(noop.status).toBe(200);
    expect((await json<{ givenNames: string }>(noop)).givenNames).toBe("Petit");
  });

  it("a different account holder cannot see another's dependent", async () => {
    const created = await harness.post("/v1/dependents", newDependent, ownerCookie);
    const { id } = await json<{ id: string }>(created);

    const otherCookie = await harness.signUpAndVerify(
      "other@example.com",
      "password12345",
      "Oth Er",
    );
    const cross = await harness.app.request(`/v1/dependents/${id}`, {
      headers: { cookie: otherCookie },
    });
    expect(cross.status).toBe(404);
  });

  it("rejects an unauthenticated request with 401", async () => {
    expect((await harness.app.request("/v1/dependents")).status).toBe(401);
  });

  it("supports multiple caregivers; soft-deletes only when the last one unlinks", async () => {
    const created = await harness.post("/v1/dependents", newDependent, ownerCookie);
    const { id } = await json<{ id: string }>(created);

    // A second caregiver, linked directly (the invitation flow arrives in slice 7).
    const cookieB = await harness.signUpAndVerify(
      "co-caregiver@example.com",
      "password12345",
      "Co Giver",
    );
    const rowsB = await harness.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, "co-caregiver@example.com"));
    await harness.db.insert(caregiverLink).values({
      id: crypto.randomUUID(),
      caregiverUserId: rowsB[0]?.id ?? "",
      managedDependentId: id,
      relationship: "parent",
      status: "active",
    });

    const seesIt = () =>
      harness.app.request(`/v1/dependents/${id}`, { headers: { cookie: cookieB } });
    expect((await seesIt()).status).toBe(200);

    // Owner A unlinks — dependent survives because B is still linked.
    expect(
      (
        await harness.app.request(`/v1/dependents/${id}`, {
          method: "DELETE",
          headers: { cookie: ownerCookie },
        })
      ).status,
    ).toBe(204);
    expect((await seesIt()).status).toBe(200);

    // B unlinks — now the last caregiver is gone, so it's soft-deleted.
    expect(
      (
        await harness.app.request(`/v1/dependents/${id}`, {
          method: "DELETE",
          headers: { cookie: cookieB },
        })
      ).status,
    ).toBe(204);
    expect((await seesIt()).status).toBe(404);
  });

  it("deleting a caregiver's account removes solely-managed dependents but keeps shared ones", async () => {
    const password = "password12345";
    const leaving = await harness.signUpAndVerify("leaving@example.com", password, "Lea Ving");

    const sole = await json<{ id: string }>(
      await harness.post("/v1/dependents", newDependent, leaving),
    );
    const shared = await json<{ id: string }>(
      await harness.post("/v1/dependents", newDependent, leaving),
    );

    // A co-caregiver links to the shared dependent so it should outlive the delete.
    const keeper = await harness.signUpAndVerify("keeper@example.com", password, "Kee Per");
    const keeperId =
      (
        await harness.db
          .select({ id: user.id })
          .from(user)
          .where(eq(user.email, "keeper@example.com"))
      )[0]?.id ?? "";
    await harness.db.insert(caregiverLink).values({
      id: crypto.randomUUID(),
      caregiverUserId: keeperId,
      managedDependentId: shared.id,
      relationship: "parent",
      status: "active",
    });

    const del = await harness.post("/api/auth/delete-user", { password }, leaving);
    expect([200, 204]).toContain(del.status);

    // Sole dependent is hard-deleted; the shared one survives and the keeper still sees it.
    const soleRows = await harness.db
      .select({ id: dependent.id })
      .from(dependent)
      .where(eq(dependent.id, sole.id));
    expect(soleRows.length).toBe(0);
    const sharedRows = await harness.db
      .select({ id: dependent.id })
      .from(dependent)
      .where(eq(dependent.id, shared.id));
    expect(sharedRows.length).toBe(1);
    expect(
      (await harness.app.request(`/v1/dependents/${shared.id}`, { headers: { cookie: keeper } }))
        .status,
    ).toBe(200);
  });
});
