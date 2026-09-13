import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { adminProfile } from "@/db/schema/admin-profile";
import type { AdminScope } from "@/domain/admin/admin";

export interface AdminRepoService {
  readonly findScope: (userId: string) => Effect.Effect<AdminScope | undefined, SqlError.SqlError>;
}

export class AdminRepo extends Context.Tag("AdminRepo")<AdminRepo, AdminRepoService>() {}

export const AdminRepoLive = Layer.effect(
  AdminRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;

    return {
      findScope: (userId) =>
        db
          .select({ scope: adminProfile.scope })
          .from(adminProfile)
          .where(eq(adminProfile.userId, userId))
          .limit(1)
          .pipe(Effect.map((rows) => rows[0]?.scope)),
    };
  }),
);
