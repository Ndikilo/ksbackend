import type { ConsultationType } from "@/domain/practitioner/practitioner";

export type PracticeLocation = {
  readonly id: string;
  readonly practitionerProfileId: string;
  readonly label: string;
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string;
  readonly region: string;
  readonly country: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly consultationTypes: ReadonlyArray<ConsultationType>;
  readonly isPrimary: boolean;
};

export type PracticeLocationInput = {
  readonly label: string;
  readonly addressLine1: string;
  readonly addressLine2?: string | undefined;
  readonly city: string;
  readonly region: string;
  readonly country: string;
  readonly consultationTypes: ReadonlyArray<ConsultationType>;
  readonly isPrimary: boolean;
};

export type PracticeLocationCreateInput = PracticeLocationInput & {
  readonly id?: string | undefined;
};
export type PracticeLocationPatch = {
  readonly label?: string | undefined;
  readonly addressLine1?: string | undefined;
  readonly addressLine2?: string | null | undefined;
  readonly city?: string | undefined;
  readonly region?: string | undefined;
  readonly country?: string | undefined;
  readonly consultationTypes?: ReadonlyArray<ConsultationType> | undefined;
  readonly isPrimary?: boolean | undefined;
};
