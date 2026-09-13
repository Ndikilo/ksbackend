/** Notification categories a user can tune independently. */
export type NotificationCategory = "appointments" | "verification" | "security" | "account";

export const NOTIFICATION_CATEGORIES = [
  "appointments",
  "verification",
  "security",
  "account",
] as const;

/** Per-channel toggles for one category. SMS delivery is deferred but selectable. */
export type ChannelPreferences = {
  readonly email: boolean;
  readonly sms: boolean;
  readonly push: boolean;
};

/** A user's resolved preference for one category. */
export type NotificationPreference = ChannelPreferences & {
  readonly category: NotificationCategory;
};

/**
 * Default channels for a category when the user hasn't customised it. Email on
 * everywhere; SMS/push off until those channels ship. Security stays on email.
 */
export const defaultChannels = (_category: NotificationCategory): ChannelPreferences => ({
  email: true,
  sms: false,
  push: false,
});
