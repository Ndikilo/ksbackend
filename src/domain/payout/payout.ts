export const PAYOUT_METHOD_KINDS = ["mtn_momo", "orange_money", "bank"] as const;
export type PayoutMethodKind = (typeof PAYOUT_METHOD_KINDS)[number];

export type PayoutMethod = {
  readonly id: string;
  readonly practitionerProfileId: string;
  readonly kind: PayoutMethodKind;
  readonly accountName: string;
  readonly maskedAccountNumber: string;
  readonly bankName: string | null;
  readonly isDefault: boolean;
};

export type PayoutMethodInput = {
  readonly kind: PayoutMethodKind;
  readonly accountName: string;
  readonly accountNumber: string;
  readonly bankName?: string | undefined;
  readonly isDefault: boolean;
};

export type PayoutMethodCreateInput = PayoutMethodInput & { readonly id?: string | undefined };
export type PayoutMethodPatch = {
  readonly kind?: PayoutMethodKind | undefined;
  readonly accountName?: string | undefined;
  readonly accountNumber?: string | undefined;
  readonly bankName?: string | null | undefined;
  readonly isDefault?: boolean | undefined;
};
