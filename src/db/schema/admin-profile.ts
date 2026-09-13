import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { adminScopeEnum } from "./enums";

// The admin extension of the base `profile`. Holds the least-privilege scope that
// gates admin actions. Admins are seeded/assigned, never self-registered.
export const adminProfile = pgTable("admin_profile", {
  id: uuid("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  scope: adminScopeEnum("scope").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
