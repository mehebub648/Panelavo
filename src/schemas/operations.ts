import { z } from "zod";

export const operationCommands = [
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
  "artisan-migrate-status",
  "artisan-migrate",
  "artisan-storage-link",
  "artisan-queue-restart",
  "symfony-cache-clear",
  "wp-core-checksums",
  "wp-cache-flush",
  "wp-cron-run",
  "django-check-deploy",
  "django-migrate-status",
  "django-migrate",
  "django-collectstatic",
  "compose-validate",
  "compose-up",
  "compose-restart",
  "compose-pull",
  "compose-ps",
  "compose-logs",
  "compose-down",
  "pm2-start",
  "pm2-restart",
  "pm2-stop",
  "pm2-delete",
  "pm2-restart-one",
  "pm2-stop-one",
  "pm2-delete-one",
  "pm2-save",
  "pm2-status",
  "pm2-logs",
  "upstream-check",
] as const;

const script = z.string().regex(/^[A-Za-z0-9:._-]{1,64}$/);
const processName = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/);

const runOperationSchema = z
  .object({
    action: z.literal("run"),
    command: z.enum(operationCommands),
    script: script.optional(),
    name: processName.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const needsScript =
      value.command === "node-run" || value.command === "npm-run";
    const needsName = [
      "pm2-restart-one",
      "pm2-stop-one",
      "pm2-delete-one",
    ].includes(value.command);
    if (needsScript !== Boolean(value.script))
      context.addIssue({
        code: "custom",
        path: ["script"],
        message: needsScript
          ? "Choose a detected package script."
          : "This action does not accept a package script.",
      });
    if (needsName !== Boolean(value.name))
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: needsName
          ? "Choose a detected PM2 process."
          : "This action does not accept a process name.",
      });
  });

const deployOperationSchema = z
  .object({
    action: z.literal("deploy"),
    plan: z.enum(["compose", "node", "static-build", "php", "python"]),
  })
  .strict();

export const operationsRequestSchema = z.union([
  runOperationSchema,
  deployOperationSchema,
]);

export type OperationsRequest = z.infer<typeof operationsRequestSchema>;
