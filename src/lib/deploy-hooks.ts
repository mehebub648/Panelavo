export const deployHookCommands = [
  "node-install",
  "node-run",
  "npm-install",
  "npm-ci",
  "npm-run",
  "composer-install",
  "composer-install-production",
  "composer-validate",
  "python-create-venv",
  "python-install",
  "pip-install",
  "artisan-optimize",
  "artisan-optimize-clear",
  "artisan-migrate",
  "artisan-storage-link",
  "artisan-queue-restart",
  "symfony-cache-clear",
  "wp-cache-flush",
  "wp-cron-run",
  "django-check-deploy",
  "django-migrate",
  "django-collectstatic",
  "compose-validate",
  "compose-pull",
  "compose-deploy",
  "compose-up",
  "compose-restart",
  "compose-ps",
  "pm2-start",
  "pm2-restart",
  "pm2-restart-one",
  "pm2-save",
  "upstream-check",
] as const;

export type DeployHookOperation = {
  command: (typeof deployHookCommands)[number];
  script?: string;
  name?: string;
};
