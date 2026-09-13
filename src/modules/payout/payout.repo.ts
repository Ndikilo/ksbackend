import { SqlError } from "@effect/sql";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { payoutMethod } from "@/db/schema/payout-method";
import type { PayoutMethod, PayoutMethodKind } from "@/domain/payout/payout";

type Row = typeof payoutMethod.$inferSelect;
const toDomain = (row: Row): PayoutMethod => ({
  id: row.id,
  practitionerProfileId: row.practitionerProfileId,
  kind: row.kind,
  accountName: row.accountName,
  maskedAccountNumber: `••••${row.accountNumberLast3}`,
  bankName: row.bankName,
  isDefault: row.isDefault,
});
export type StoredPayout = {
  readonly kind: PayoutMethodKind;
  readonly accountName: string;
  readonly accountNumberEncrypted: string;
  readonly accountNumberHmac: string;
  readonly accountNumberLast3: string;
  readonly bankName: string | null;
  readonly isDefault: boolean;
};
export type StoredPayoutPatch = {
  readonly kind?: PayoutMethodKind | undefined;
  readonly accountName?: string | undefined;
  readonly accountNumberEncrypted?: string | undefined;
  readonly accountNumberHmac?: string | undefined;
  readonly accountNumberLast3?: string | undefined;
  readonly bankName?: string | null | undefined;
  readonly isDefault?: boolean | undefined;
};
export interface PayoutRepoService {
  readonly list: (
    practitionerProfileId: string,
  ) => Effect.Effect<ReadonlyArray<PayoutMethod>, SqlError.SqlError>;
  readonly hasDuplicate: (
    practitionerProfileId: string,
    hmac: string,
    exceptId: string | undefined,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly idExists: (id: string) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly clearDefault: (
    practitionerProfileId: string,
    exceptId: string | undefined,
    updatedAt: Date,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly insert: (
    row: StoredPayout & {
      readonly id: string;
      readonly practitionerProfileId: string;
      readonly createdAt: Date;
      readonly updatedAt: Date;
    },
  ) => Effect.Effect<PayoutMethod, SqlError.SqlError>;
  readonly update: (
    practitionerProfileId: string,
    id: string,
    input: StoredPayoutPatch,
    updatedAt: Date,
  ) => Effect.Effect<PayoutMethod | undefined, SqlError.SqlError>;
  readonly softDelete: (
    practitionerProfileId: string,
    id: string,
    deletedAt: Date,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
}
export class PayoutRepo extends Context.Tag("PayoutRepo")<PayoutRepo, PayoutRepoService>() {}
export const PayoutRepoLive = Layer.effect(
  PayoutRepo,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.PgDrizzle;
    return {
      list: (practitionerProfileId) =>
        db
          .select()
          .from(payoutMethod)
          .where(
            and(
              eq(payoutMethod.practitionerProfileId, practitionerProfileId),
              isNull(payoutMethod.deletedAt),
            ),
          )
          .orderBy(desc(payoutMethod.isDefault), asc(payoutMethod.id))
          .pipe(Effect.map((rows) => rows.map(toDomain))),
      hasDuplicate: (practitionerProfileId, hmac, exceptId) =>
        db
          .select({ id: payoutMethod.id })
          .from(payoutMethod)
          .where(
            and(
              eq(payoutMethod.practitionerProfileId, practitionerProfileId),
              eq(payoutMethod.accountNumberHmac, hmac),
              isNull(payoutMethod.deletedAt),
              exceptId === undefined ? undefined : ne(payoutMethod.id, exceptId),
            ),
          )
          .limit(1)
          .pipe(Effect.map((rows) => rows.length > 0)),
      idExists: (id) =>
        db
          .select({ id: payoutMethod.id })
          .from(payoutMethod)
          .where(eq(payoutMethod.id, id))
          .limit(1)
          .pipe(Effect.map((rows) => rows.length > 0)),
      clearDefault: (practitionerProfileId, exceptId, updatedAt) =>
        db
          .update(payoutMethod)
          .set({ isDefault: false, updatedAt })
          .where(
            and(
              eq(payoutMethod.practitionerProfileId, practitionerProfileId),
              eq(payoutMethod.isDefault, true),
              isNull(payoutMethod.deletedAt),
              exceptId === undefined ? undefined : ne(payoutMethod.id, exceptId),
            ),
          )
          .pipe(Effect.asVoid),
      insert: (row) =>
        db
          .insert(payoutMethod)
          .values(row)
          .returning()
          .pipe(
            Effect.flatMap((rows) =>
              rows[0]
                ? Effect.succeed(toDomain(rows[0]))
                : Effect.dieMessage("Payout method insert returned no row."),
            ),
          ),
      update: (practitionerProfileId, id, input, updatedAt) =>
        db
          .update(payoutMethod)
          .set({ ...input, updatedAt })
          .where(
            and(
              eq(payoutMethod.id, id),
              eq(payoutMethod.practitionerProfileId, practitionerProfileId),
              isNull(payoutMethod.deletedAt),
            ),
          )
          .returning()
          .pipe(Effect.map((rows) => (rows[0] ? toDomain(rows[0]) : undefined))),
      softDelete: (practitionerProfileId, id, deletedAt) =>
        db
          .update(payoutMethod)
          .set({ deletedAt, isDefault: false, updatedAt: deletedAt })
          .where(
            and(
              eq(payoutMethod.id, id),
              eq(payoutMethod.practitionerProfileId, practitionerProfileId),
              isNull(payoutMethod.deletedAt),
            ),
          )
          .returning({ id: payoutMethod.id })
          .pipe(Effect.map((rows) => rows.length > 0)),
    } satisfies PayoutRepoService;
  }),
);
