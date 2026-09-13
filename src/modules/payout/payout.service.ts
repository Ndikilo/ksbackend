import { SqlClient, SqlError } from "@effect/sql";
import { Clock, Context, Effect, Layer } from "effect";
import type {
  PayoutMethod,
  PayoutMethodCreateInput,
  PayoutMethodInput,
  PayoutMethodPatch,
} from "@/domain/payout/payout";
import { Conflict, NotFound } from "@/domain/shared/errors";
import { Crypto } from "@/infra/crypto";
import { IdGenerator } from "@/infra/ids";
import { PractitionerRepo } from "@/modules/practitioner/practitioner.repo";
import { PayoutRepo, type StoredPayout, type StoredPayoutPatch } from "./payout.repo";
export interface PayoutServiceService {
  readonly listMine: (
    userId: string,
  ) => Effect.Effect<ReadonlyArray<PayoutMethod>, NotFound | SqlError.SqlError>;
  readonly create: (
    userId: string,
    input: PayoutMethodCreateInput,
  ) => Effect.Effect<PayoutMethod, NotFound | Conflict | SqlError.SqlError>;
  readonly update: (
    userId: string,
    id: string,
    input: PayoutMethodPatch,
  ) => Effect.Effect<PayoutMethod, NotFound | Conflict | SqlError.SqlError>;
  readonly remove: (
    userId: string,
    id: string,
  ) => Effect.Effect<void, NotFound | SqlError.SqlError>;
}
export class PayoutService extends Context.Tag("PayoutService")<
  PayoutService,
  PayoutServiceService
>() {}
export const PayoutServiceLive = Layer.effect(
  PayoutService,
  Effect.gen(function* () {
    const repo = yield* PayoutRepo;
    const practitioners = yield* PractitionerRepo;
    const crypto = yield* Crypto;
    const ids = yield* IdGenerator;
    const sql = yield* SqlClient.SqlClient;
    const ownerId = (userId: string) =>
      practitioners
        .findByUserId(userId)
        .pipe(
          Effect.flatMap((found) =>
            found
              ? Effect.succeed(found.id)
              : Effect.fail(new NotFound({ resource: "Practitioner profile" })),
          ),
        );
    const stored = (input: PayoutMethodInput): Effect.Effect<StoredPayout> =>
      crypto.encrypt(input.accountNumber).pipe(
        Effect.map((encrypted) => ({
          kind: input.kind,
          accountName: input.accountName,
          accountNumberEncrypted: encrypted,
          accountNumberHmac: crypto.hmac(input.accountNumber),
          accountNumberLast3: input.accountNumber.slice(-3),
          bankName: input.bankName ?? null,
          isDefault: input.isDefault,
        })),
      );
    const assertUnique = (
      practitionerProfileId: string,
      hmac: string,
      exceptId: string | undefined,
    ) =>
      repo.hasDuplicate(practitionerProfileId, hmac, exceptId).pipe(
        Effect.flatMap((duplicate) =>
          duplicate
            ? Effect.fail(
                new Conflict({
                  resource: "Payout method",
                  reason: "Account is already registered.",
                }),
              )
            : Effect.void,
        ),
      );
    return {
      listMine: (userId) => ownerId(userId).pipe(Effect.flatMap(repo.list)),
      create: (userId, input) =>
        Effect.gen(function* () {
          const practitionerProfileId = yield* ownerId(userId);
          const data = yield* stored(input);
          const id = input.id ?? (yield* ids.next);
          if (input.id !== undefined && (yield* repo.idExists(input.id))) {
            return yield* Effect.fail(
              new Conflict({ resource: "Payout method", reason: "ID is already in use." }),
            );
          }
          yield* assertUnique(practitionerProfileId, data.accountNumberHmac, undefined);
          const now = new Date(yield* Clock.currentTimeMillis);
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              if (data.isDefault) yield* repo.clearDefault(practitionerProfileId, undefined, now);
              return yield* repo.insert({
                id,
                practitionerProfileId,
                ...data,
                createdAt: now,
                updatedAt: now,
              });
            }),
          );
        }),
      update: (userId, id, input) =>
        Effect.gen(function* () {
          const practitionerProfileId = yield* ownerId(userId);
          const accountNumber = input.accountNumber;
          const accountPatch: StoredPayoutPatch =
            accountNumber === undefined
              ? {}
              : yield* crypto.encrypt(accountNumber).pipe(
                  Effect.map((encrypted) => ({
                    accountNumberEncrypted: encrypted,
                    accountNumberHmac: crypto.hmac(accountNumber),
                    accountNumberLast3: accountNumber.slice(-3),
                  })),
                );
          if (accountPatch.accountNumberHmac !== undefined) {
            yield* assertUnique(practitionerProfileId, accountPatch.accountNumberHmac, id);
          }
          const data: StoredPayoutPatch = {
            ...accountPatch,
            ...(input.kind !== undefined && { kind: input.kind }),
            ...(input.accountName !== undefined && { accountName: input.accountName }),
            ...(input.bankName !== undefined && { bankName: input.bankName }),
            ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
          };
          const now = new Date(yield* Clock.currentTimeMillis);
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              if (data.isDefault === true) yield* repo.clearDefault(practitionerProfileId, id, now);
              const updated = yield* repo.update(practitionerProfileId, id, data, now);
              return updated ?? (yield* Effect.fail(new NotFound({ resource: "Payout method" })));
            }),
          );
        }),
      remove: (userId, id) =>
        Effect.gen(function* () {
          const removed = yield* repo.softDelete(
            yield* ownerId(userId),
            id,
            new Date(yield* Clock.currentTimeMillis),
          );
          if (!removed) return yield* Effect.fail(new NotFound({ resource: "Payout method" }));
        }),
    } satisfies PayoutServiceService;
  }),
);
