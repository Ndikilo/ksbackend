import { Effect } from "effect";
import { Forbidden } from "@/domain/shared/errors";
import { CurrentUser, type Role } from "./auth";

/** Fail with `Forbidden` unless the current user holds `role`. Requires `CurrentUser`. */
export const requireRole = (role: Role): Effect.Effect<void, Forbidden, CurrentUser> =>
  Effect.flatMap(CurrentUser, (current) =>
    current.roles.includes(role)
      ? Effect.void
      : Effect.fail(new Forbidden({ reason: `Requires the "${role}" role.` })),
  );

/** Fail with `Forbidden` unless the current user holds at least one of `roles`. */
export const requireAnyRole = (
  ...roles: ReadonlyArray<Role>
): Effect.Effect<void, Forbidden, CurrentUser> =>
  Effect.flatMap(CurrentUser, (current) =>
    roles.some((role) => current.roles.includes(role))
      ? Effect.void
      : Effect.fail(new Forbidden({ reason: `Requires one of: ${roles.join(", ")}.` })),
  );
