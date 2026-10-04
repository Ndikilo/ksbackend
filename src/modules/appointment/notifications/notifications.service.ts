import { SqlError } from "@effect/sql";
import { Context, Effect, Layer } from "effect";

import {
  RECEIPT_SCENARIO_ID,
  lifecycleDedupKey,
  lifecycleNameParam,
  lifecyclePlan,
  lifecycleScenarioId,
  receiptDedupKey,
  type LifecycleActor,
  type LifecycleScenario,
} from "@/domain/appointment/notifications";
import type { ChannelPreferences } from "@/domain/notification/notification";
import type { PaymentProvider } from "@/domain/payment/payment";
import { deliverableChannels, type OutboxPayload } from "@/domain/notification/outbox";
import { formatClinicInstant, renderEmail } from "@/infra/email-render";
import { negotiateLocale, translate } from "@/infra/i18n";
import { OutboxService } from "@/modules/outbox/outbox.service";
import { LifecycleRepo } from "./notifications.repo";

/**
 * Lifecycle notifier (P6.T3): turns an appointment transition into the EXACT
 * set of outbox rows it owes — the pure plan (domain/appointment/notifications
 * .ts) drives who learns what; this module does the orchestration (identity
 * lookups, preference gating, per-recipient rendering, dedup-keyed enqueue).
 *
 * Called INSIDE the transition's transaction: a rolled-back booking/reschedule
 * /cancellation never notifies, and the enqueue commits atomically with the
 * state change it announces. The dedup keys make a retried transition (or two
 * racing ones) a database-level no-op.
 *
 * Gate placement (P6.T4): preference gating happens at ENQUEUE, through the
 * shared `deliverableChannels` primitive — a switched-off channel enqueues
 * NOTHING, so the outbox row count is the truth about what was ever meant to
 * be delivered. Lifecycle copy is gated by the `appointments` category; the
 * payment receipt is a financial record and rides the `account` category
 * instead (turning appointment emails off never hides a receipt).
 */

/** The appointment fields the notifier renders from (no state reads). */
export type LifecycleNotificationAppointment = {
  readonly id: string;
  readonly patientUserId: string;
  readonly practitionerProfileId: string;
  readonly startsAt: Date;
};

export type NotifyLifecycleInput = {
  readonly appointment: LifecycleNotificationAppointment;
  readonly scenario: LifecycleScenario;
  /** Who drove the transition — decides the cancellation copy variants. */
  readonly actor: LifecycleActor;
  /**
   * Transition instant for REPEATABLE transitions (reschedule): the dedup key
   * carries it, so A→B→A notifies twice (a content-only key would dedup the
   * move back and the practitioner would believe the stale time).
   */
  readonly sequence?: number | undefined;
};

export type ReceiptEmailInput = {
  readonly patientUserId: string;
  /** The charge as it stands AFTER the succeeded terminal write. */
  readonly payment: {
    readonly id: string;
    readonly receiptNumber: string;
    readonly amountXaf: number;
    readonly provider: PaymentProvider;
    readonly receiptIssuedAt: Date;
  };
};

/** Enqueue accounting — `duplicates` are dedup wins by an earlier attempt. */
export type EnqueueSummary = {
  readonly enqueued: number;
  readonly duplicates: number;
};

/** One prepared outbox row: everything enqueue needs, already rendered. */
type EnqueuePlanRow = {
  readonly userId: string;
  readonly email: string;
  readonly locale: string;
  readonly channelCategory: "appointments" | "account";
  readonly scenario: string;
  readonly dedupKey: string;
  readonly payload: OutboxPayload;
};

export interface LifecycleNotifierService {
  /**
   * Enqueue every notification `lifecyclePlan(scenario, actor)` owes for this
   * appointment — one row per (recipient × deliverable channel), copy rendered
   * in each RECIPIENT's stored locale, clinic-local time. Never sends inline.
   */
  readonly notify: (
    input: NotifyLifecycleInput,
  ) => Effect.Effect<EnqueueSummary, SqlError.SqlError>;
  /**
   * Enqueue the payment receipt email (P5.T4's send wiring) — once per charge
   * (dedup keyed on the payment id), gated by the `account` category.
   */
  readonly receipt: (input: ReceiptEmailInput) => Effect.Effect<EnqueueSummary, SqlError.SqlError>;
}

export class LifecycleNotifier extends Context.Tag("LifecycleNotifier")<
  LifecycleNotifier,
  LifecycleNotifierService
>() {}

export const LifecycleNotifierLive = Layer.effect(
  LifecycleNotifier,
  Effect.gen(function* () {
    const repo = yield* LifecycleRepo;
    const outbox = yield* OutboxService;

    const enqueueAll = (
      plan: ReadonlyArray<EnqueuePlanRow>,
      stored: ReadonlyMap<string, ChannelPreferences>,
    ) =>
      Effect.gen(function* () {
        let enqueued = 0;
        let duplicates = 0;
        for (const row of plan) {
          // Email is the only addressable channel today — SMS needs a phone
          // identity (P8.T6), push a stored device token. `available` carries
          // email only, so the deliverable set is ["email"] or [].
          for (const channel of deliverableChannels(stored.get(row.userId), {
            email: row.email,
          })) {
            const inserted = yield* outbox.enqueue({
              userId: row.userId,
              channel,
              category: row.channelCategory,
              scenario: row.scenario,
              locale: row.locale,
              recipient: row.email,
              payload: row.payload,
              dedupKey: row.dedupKey,
            });
            if (inserted === undefined) duplicates += 1;
            else enqueued += 1;
          }
        }
        return { enqueued, duplicates } satisfies EnqueueSummary;
      });

    const notify = (input: NotifyLifecycleInput) =>
      Effect.gen(function* () {
        const parties = yield* repo.parties({
          patientUserId: input.appointment.patientUserId,
          practitionerProfileId: input.appointment.practitionerProfileId,
        });
        if (parties === undefined) return { enqueued: 0, duplicates: 0 } satisfies EnqueueSummary;

        // Copy is rendered per RECIPIENT (their stored locale, app default fr)
        // — these rows are delivered asynchronously, never in the requester's
        // Accept-Language.
        const stored = yield* repo.preferencesFor(
          [parties.patient.userId, parties.practitioner.userId],
          "appointments",
        );
        const plan = lifecyclePlan(input.scenario, input.actor).map((entry): EnqueuePlanRow => {
          const party = parties[entry.recipient];
          const locale = negotiateLocale(party.locale ?? undefined, "fr");
          const nameIsPatient = lifecycleNameParam(entry.variant) === "patient";
          const params = {
            when: formatClinicInstant(locale, input.appointment.startsAt),
            patient: parties.patient.name,
            practitioner: parties.practitioner.name,
          };
          const ns = `emails.appointment.${entry.variant}`;
          const payload: OutboxPayload = {
            title: translate(locale, `${ns}.subject`, params),
            bodyText: translate(locale, `${ns}.body`, params),
            bodyHtml: renderEmail(
              {
                kind: "appointment",
                variant: entry.variant,
                when: input.appointment.startsAt,
                counterpart: nameIsPatient ? parties.patient.name : parties.practitioner.name,
              },
              locale,
            ).html,
          };
          return {
            userId: party.userId,
            email: party.email,
            locale,
            channelCategory: "appointments",
            scenario: lifecycleScenarioId[input.scenario],
            dedupKey: lifecycleDedupKey(
              input.scenario,
              input.appointment.id,
              entry.recipient,
              "email",
              input.sequence,
            ),
            payload,
          };
        });
        return yield* enqueueAll(plan, stored);
      });

    const receipt = (input: ReceiptEmailInput) =>
      Effect.gen(function* () {
        const identity = yield* repo.userById(input.patientUserId);
        if (identity === undefined) {
          return { enqueued: 0, duplicates: 0 } satisfies EnqueueSummary;
        }
        // The receipt rides the `account` category (a financial record —
        // turning appointment emails off never hides a receipt).
        const stored = yield* repo.preferencesFor([identity.userId], "account");
        const locale = negotiateLocale(identity.locale ?? undefined, "fr");
        const payload: OutboxPayload = {
          title: translate(locale, "emails.receipt.subject", {
            receiptNumber: input.payment.receiptNumber,
          }),
          bodyText: [
            translate(locale, "emails.receipt.intro"),
            `${translate(locale, "emails.receipt.receiptNumber")}: ${input.payment.receiptNumber}`,
            `${translate(locale, "emails.receipt.amount")}: ${input.payment.amountXaf} XAF`,
          ].join("\n"),
          bodyHtml: renderEmail(
            {
              kind: "receipt",
              receipt: {
                receiptNumber: input.payment.receiptNumber,
                amountXaf: input.payment.amountXaf,
                provider: input.payment.provider,
                paidAt: input.payment.receiptIssuedAt,
                reference: input.payment.id,
              },
            },
            locale,
          ).html,
        };
        return yield* enqueueAll(
          [
            {
              userId: identity.userId,
              email: identity.email,
              locale,
              channelCategory: "account",
              scenario: RECEIPT_SCENARIO_ID,
              dedupKey: receiptDedupKey(input.payment.id, "email"),
              payload,
            },
          ],
          stored,
        );
      });

    return { notify, receipt };
  }),
);
