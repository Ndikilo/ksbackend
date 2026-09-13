import { z } from "@hono/zod-openapi";

const preference = z.object({
  category: z.enum(["appointments", "verification", "security", "account"]).openapi({
    description:
      "Which class of notification this row governs. `appointments`: bookings, reminders, changes. `verification`: identity/document checks. `security`: sign-ins, password changes, suspicious activity. `account`: billing, receipts, general account admin.",
    example: "appointments",
  }),
  email: z.boolean().openapi({ description: "Deliver this category over email.", example: true }),
  sms: z.boolean().openapi({ description: "Deliver this category over SMS.", example: false }),
  push: z
    .boolean()
    .openapi({ description: "Deliver this category over push notifications.", example: true }),
});

export const NotificationPreferencesResponse = z
  .object({
    preferences: z.array(preference).openapi({
      description:
        "The full preference matrix — one row per category. Every category is always present; any the user has never touched are returned filled with server defaults.",
    }),
  })
  .openapi("NotificationPreferences");

export const UpdateNotificationPreferencesBody = z
  .object({
    preferences: z
      .array(preference)
      .min(1)
      .max(20)
      .openapi({
        description:
          "The category rows you want to change — send only those, not the whole matrix. Each row upserts the per-channel flags for its category (1–20 rows). Categories you omit are left untouched.",
        example: [{ category: "appointments", email: true, sms: false, push: true }],
      }),
  })
  .openapi("UpdateNotificationPreferences");
