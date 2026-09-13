import { sql } from "drizzle-orm";
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { payoutMethodKindEnum } from "./enums";
import { practitionerProfile } from "./practitioner-profile";

export const payoutMethod = pgTable(
  "payout_method",
  {
    id: uuid("id").primaryKey(),
    practitionerProfileId: uuid("practitioner_profile_id")
      .notNull()
      .references(() => practitionerProfile.id, { onDelete: "cascade" }),
    kind: payoutMethodKindEnum("kind").notNull(),
    accountName: text("account_name").notNull(),
    accountNumberEncrypted: text("account_number_encrypted").notNull(),
    accountNumberHmac: text("account_number_hmac").notNull(),
    accountNumberLast3: text("account_number_last_3").notNull(),
    bankName: text("bank_name"),
    isDefault: boolean("is_default").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("payout_method_account_active_unique")
      .on(table.practitionerProfileId, table.accountNumberHmac)
      .where(sql`${table.deletedAt} is null`),
    uniqueIndex("payout_method_one_default")
      .on(table.practitionerProfileId)
      .where(sql`${table.isDefault} = true and ${table.deletedAt} is null`),
  ],
);
