import { boolean, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { notificationCategoryEnum } from "./enums";

// A user's notification preference for one category, per channel. Medium
// granularity: the user chooses email/sms/push independently per category.
// Missing rows fall back to code defaults. Cascades on user delete.
export const notificationPreference = pgTable(
  "notification_preference",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    category: notificationCategoryEnum("category").notNull(),
    email: boolean("email").notNull(),
    sms: boolean("sms").notNull(),
    push: boolean("push").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.userId, table.category)],
);
