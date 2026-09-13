import { boolean, pgTable, text, uuid } from "drizzle-orm/pg-core";

// Reference table for the practitioner "profession" dropdown (admin-manageable,
// bilingual labels). Seeded with an initial set.
export const profession = pgTable("profession", {
  id: uuid("id").primaryKey(),
  nameEn: text("name_en").notNull(),
  nameFr: text("name_fr").notNull(),
  prefixHint: text("prefix_hint"),
  active: boolean("active").notNull().default(true),
});
