import { z } from "zod";
import { encryptedJsonStore } from "@/server/storage/encrypted-json-store";
import { AppError } from "@/server/cloudpanel/errors";

export const notificationSettingsSchema = z
  .object({
    smtp: z
      .object({
        enabled: z.boolean(),
        host: z.string().trim().max(253),
        port: z.number().int().min(1).max(65535),
        secure: z.boolean(),
        username: z.string().max(256),
        password: z.string().max(512),
        from: z.union([z.string().email().max(254), z.literal("")]),
        to: z.union([z.string().email().max(254), z.literal("")]),
      })
      .strict(),
    webhook: z
      .object({
        enabled: z.boolean(),
        url: z.union([
          z.string().url().max(1000).refine((value) => value.startsWith("https://"), {
            message: "The webhook must use HTTPS.",
          }),
          z.literal(""),
        ]),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.smtp.enabled && (!value.smtp.host || !value.smtp.from || !value.smtp.to))
      context.addIssue({ code: "custom", path: ["smtp"], message: "Complete the enabled SMTP channel." });
    if (value.webhook.enabled && !value.webhook.url)
      context.addIssue({ code: "custom", path: ["webhook", "url"], message: "Enter the enabled webhook URL." });
  });

export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
type Store = { settings?: NotificationSettings };
const store = encryptedJsonStore<Store>("notification-settings.enc", () => ({}));

export async function getNotificationSettings() {
  return (await store.load()).settings;
}

export async function getPublicNotificationSettings() {
  const settings = await getNotificationSettings();
  if (!settings) return null;
  return {
    smtp: {
      ...settings.smtp,
      password: "",
      hasPassword: Boolean(settings.smtp.password),
    },
    webhook: { ...settings.webhook, url: settings.webhook.url },
  };
}

export async function saveNotificationSettings(input: NotificationSettings) {
  const current = await getNotificationSettings();
  const password = input.smtp.password || current?.smtp.password;
  if (input.smtp.enabled && !password)
    throw new AppError("INVALID_REQUEST", "Enter the SMTP password.", 400);
  const value = { ...input, smtp: { ...input.smtp, password: password ?? "" } };
  await store.save({ settings: value });
  return getPublicNotificationSettings();
}
