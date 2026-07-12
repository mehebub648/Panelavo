import { z } from "zod";

const gitPath = z.string().min(1).max(4096).refine((value) => !value.includes("\0"));
const gitBranch = z.union([z.string().regex(/^[A-Za-z0-9._\/-]{1,200}$/), z.literal("")]).optional();
export const gitRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("clone"), url: z.string().min(1).max(1000), branch: gitBranch }).strict(),
  z.object({ action: z.literal("init") }).strict(),
  z.object({ action: z.literal("set-remote"), url: z.string().min(1).max(1000) }).strict(),
  z.object({ action: z.literal("fetch") }).strict(),
  z.object({ action: z.literal("pull"), branch: gitBranch }).strict(),
  z.object({ action: z.literal("push"), branch: gitBranch }).strict(),
  z.object({ action: z.literal("checkout"), branch: z.string().regex(/^[A-Za-z0-9._\/-]{1,200}$/) }).strict(),
  z.object({ action: z.literal("commit"), message: z.string().trim().min(1).max(500) }).strict(),
  z.object({ action: z.literal("diff"), path: gitPath }).strict(),
  z.object({ action: z.literal("discard"), path: gitPath }).strict(),
  z.object({ action: z.literal("discard-all") }).strict(),
]);

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
  "compose-deploy",
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

export const operationFixCommands = [
  "install-docker",
  "install-compose-plugin",
  "start-docker",
  "install-composer",
] as const;

const fixOperationSchema = z
  .object({
    action: z.literal("fix"),
    fix: z.enum(operationFixCommands),
  })
  .strict();

export const operationsRequestSchema = z.union([
  runOperationSchema,
  deployOperationSchema,
  fixOperationSchema,
]);

export type OperationsRequest = z.infer<typeof operationsRequestSchema>;

// Dotenv files the environment manager may read or write; anything else is
// rejected before it reaches the bridge.
export const managedEnvFiles = [".env", ".env.local", ".env.production"] as const;

const envEntrySchema = z
  .object({
    key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
    value: z
      .string()
      .max(4096)
      .refine((value) => !/[\0\r\n]/.test(value), {
        message: "Values cannot contain line breaks.",
      }),
  })
  .strict();

export const envRequestSchema = z
  .object({
    action: z.literal("save"),
    file: z.enum(managedEnvFiles),
    entries: z.array(envEntrySchema).max(200),
    syncProfile: z.boolean().optional(),
  })
  .strict();

export type EnvRequest = z.infer<typeof envRequestSchema>;

const backupDatabaseName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const backupId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

export const backupRequestSchema = z.union([
  z
    .object({
      action: z.literal("create"),
      files: z.boolean().optional(),
      databases: z.array(backupDatabaseName).max(50).optional(),
      note: z.string().max(200).optional(),
    })
    .strict(),
  z.object({ action: z.literal("delete"), id: backupId }).strict(),
  z
    .object({
      action: z.literal("restore"),
      id: backupId,
      scope: z.enum(["all", "files", "databases"]).optional(),
    })
    .strict(),
]);

export type BackupRequest = z.infer<typeof backupRequestSchema>;

export const terminalRequestSchema = z
  .object({
    action: z.literal("exec"),
    command: z
      .string()
      .min(1)
      .max(4000)
      .refine((value) => !value.includes("\0"), {
        message: "Commands cannot contain NUL bytes.",
      }),
    cwd: z.string().max(512).optional(),
  })
  .strict();

export type TerminalRequest = z.infer<typeof terminalRequestSchema>;
