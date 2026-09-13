import type { ConsultationType } from "@/domain/practitioner/practitioner";

export const SLOT_STATUSES = ["open", "booked", "cancelled"] as const;
export type SlotStatus = (typeof SLOT_STATUSES)[number];

/** A bookable time slot a practitioner has published. */
export type AvailabilitySlot = {
  readonly id: string;
  readonly practitionerProfileId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly consultationTypes: ReadonlyArray<ConsultationType>;
  readonly locationId: string | null;
  readonly status: SlotStatus;
};

/** What a practitioner submits to publish a slot. */
export type SlotInput = {
  readonly id?: string | undefined;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly consultationTypes: ReadonlyArray<ConsultationType>;
  readonly locationId: string | null;
};

export const AVAILABILITY_EXCEPTION_KINDS = ["blocked", "extra"] as const;
export type AvailabilityExceptionKind = (typeof AVAILABILITY_EXCEPTION_KINDS)[number];

export type AvailabilityRule = {
  readonly id: string;
  readonly practitionerProfileId: string;
  /** JavaScript weekday: Sunday = 0, Saturday = 6. */
  readonly weekday: number;
  readonly startTime: string;
  readonly endTime: string;
  readonly slotDurationMin: number;
  readonly consultationTypes: ReadonlyArray<ConsultationType>;
  readonly locationId: string | null;
  readonly timezone: "Africa/Douala";
  readonly validFrom: string | null;
  readonly validTo: string | null;
};

export type AvailabilityRuleInput = Omit<AvailabilityRule, "id" | "practitionerProfileId">;

export type AvailabilityException = {
  readonly id: string;
  readonly practitionerProfileId: string;
  readonly date: string;
  readonly kind: AvailabilityExceptionKind;
  readonly startTime: string | null;
  readonly endTime: string | null;
  readonly consultationTypes: ReadonlyArray<ConsultationType> | null;
  readonly locationId: string | null;
};

export type AvailabilityExceptionInput = Omit<
  AvailabilityException,
  "id" | "practitionerProfileId"
> & { readonly id?: string | undefined };

export type PublicAvailabilitySlot = {
  /** Stable opaque identity suitable for a later booking command. */
  readonly key: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly consultationTypes: ReadonlyArray<ConsultationType>;
  readonly locationId: string | null;
  readonly source: "rule" | "exception" | "explicit";
};
