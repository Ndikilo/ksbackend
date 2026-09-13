import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const language = pgTable(
  "language",
  {
    id: uuid("id").primaryKey(),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameFr: text("name_fr").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("language_code_unique").on(table.code)],
);
