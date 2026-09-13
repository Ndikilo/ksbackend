import type { ConsultationType } from "@/domain/practitioner/practitioner";

export type ConsultationOffering = {
  readonly id: string;
  readonly practitionerProfileId: string;
  readonly consultationType: ConsultationType;
  readonly durationMin: number;
  readonly priceXaf: number;
  readonly active: boolean;
};

export type ConsultationOfferingInput = Omit<ConsultationOffering, "id" | "practitionerProfileId">;
export type ConsultationOfferingCreateInput = ConsultationOfferingInput & {
  readonly id?: string | undefined;
};
export type ConsultationOfferingPatch = {
  readonly consultationType?: ConsultationType | undefined;
  readonly durationMin?: number | undefined;
  readonly priceXaf?: number | undefined;
  readonly active?: boolean | undefined;
};
