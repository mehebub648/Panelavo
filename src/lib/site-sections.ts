export const SITE_SECTIONS = [
  "settings",
  "domains",
  "actions",
  "vhost",
  "databases",
  "certificates",
  "security",
  "users",
  "file-manager",
  "git",
  "env",
  "terminal",
  "backups",
  "cron-jobs",
  "logs",
] as const;

export type SiteSection = (typeof SITE_SECTIONS)[number];

export const SERVICE_SECTIONS: ReadonlySet<string> = new Set([
  "settings",
  "domains",
  "certificates",
  "security",
  "users",
]);

export function isSiteSection(value: string): value is SiteSection {
  return (SITE_SECTIONS as readonly string[]).includes(value);
}
