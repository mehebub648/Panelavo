import nodemailer from "nodemailer";
import { getNotificationSettings } from "./store";

export type Notification = {
  title: string;
  message: string;
  severity: "info" | "warning" | "critical" | "recovery";
  event: string;
  site?: string;
};

export async function sendNotification(notification: Notification) {
  const settings = await getNotificationSettings();
  if (!settings) return { configured: false, email: null, webhook: null };
  const occurredAt = new Date().toISOString();
  const email = settings.smtp.enabled
    ? nodemailer
        .createTransport({
          host: settings.smtp.host,
          port: settings.smtp.port,
          secure: settings.smtp.secure,
          auth: settings.smtp.username
            ? { user: settings.smtp.username, pass: settings.smtp.password }
            : undefined,
          connectionTimeout: 10_000,
          greetingTimeout: 10_000,
          socketTimeout: 15_000,
        })
        .sendMail({
          from: settings.smtp.from,
          to: settings.smtp.to,
          subject: `[Panelavo] ${notification.title}`,
          text: `${notification.message}\n\nSeverity: ${notification.severity}\nEvent: ${notification.event}${notification.site ? `\nSite: ${notification.site}` : ""}\nTime: ${occurredAt}`,
        })
        .then(() => true, () => false)
    : Promise.resolve(null);
  const webhook = settings.webhook.enabled
    ? fetch(settings.webhook.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...notification,
          occurredAt,
          text: `${notification.title}: ${notification.message}`,
          content: `**${notification.title}**\n${notification.message}`,
        }),
        signal: AbortSignal.timeout(15_000),
      }).then((response) => response.ok, () => false)
    : Promise.resolve(null);
  const [emailResult, webhookResult] = await Promise.all([email, webhook]);
  return { configured: true, email: emailResult, webhook: webhookResult };
}
