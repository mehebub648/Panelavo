import { z } from "zod4";
import { operationCommands, operationFixCommands } from "@/schemas/operations";

const MAX_UNTYPED_OPERATION_BYTES = 128 * 1024;
const MAX_FILE_MANAGER_OPERATION_BYTES = 90 * 1024 * 1024;
const MAX_FILE_READ_BYTES = 5 * 1024 * 1024;
const MAX_FILE_UPLOAD_BASE64_BYTES = 89_478_488;
const UNTYPED_SECTION_LIMITS = new Map<string, number>([
  ["vhost", MAX_UNTYPED_OPERATION_BYTES],
  ["databases", MAX_UNTYPED_OPERATION_BYTES],
  ["certificates", MAX_UNTYPED_OPERATION_BYTES],
  ["security", MAX_UNTYPED_OPERATION_BYTES],
  ["users", MAX_UNTYPED_OPERATION_BYTES],
  ["file-manager", MAX_FILE_MANAGER_OPERATION_BYTES],
  ["cron-jobs", MAX_UNTYPED_OPERATION_BYTES],
  ["logs", MAX_UNTYPED_OPERATION_BYTES],
]);

const domainSchema = z
  .string()
  .min(1)
  .max(253)
  .describe("The website's Panelavo system domain or visible domain.");

const noNul = (value: string) => !value.includes("\0");
const noControlCharacters = (value: string) => !/[\x00-\x1f\x7f]/.test(value);

function limitedOperation<T extends z.ZodType>(schema: T) {
  return schema.refine(
    (value) =>
      Buffer.byteLength(JSON.stringify(value), "utf8") <=
      MAX_UNTYPED_OPERATION_BYTES,
    "The operation must be 128 KiB or smaller.",
  );
}

const resourceIdSchema = z
  .union([
    z.number().int().positive(),
    z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .max(20),
  ])
  .describe("The numeric ID returned when this website area was inspected.");

const databaseIdentifierSchema = z
  .string()
  .min(2)
  .max(50)
  .regex(/^[A-Za-z][A-Za-z0-9-]+$/);

const passwordSchema = z
  .string()
  .min(12)
  .max(128)
  .refine(
    noControlCharacters,
    "The password contains an unsupported character.",
  );

const pathSchema = z
  .string()
  .max(4096)
  .refine(noNul, "Paths cannot contain NUL bytes.")
  .refine((value) => {
    const normalized = value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    return normalized.split("/").every((part) => part !== "." && part !== "..");
  }, "Paths cannot contain dot or parent-directory segments.");

const requiredPathSchema = pathSchema.refine(
  (value) => value.replace(/[\\/]/g, "").length > 0,
  "Choose a path.",
);

const filenameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(noNul, "Names cannot contain NUL bytes.")
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !value.includes("/") &&
      !value.includes("\\"),
    "Use one file or folder name, without path separators.",
  );

const vhostOperationSchema = limitedOperation(
  z
    .object({
      action: z.literal("save"),
      content: z
        .string()
        .max(500_000)
        .describe("The complete NGINX vhost template to validate and save."),
    })
    .strict(),
);

const databaseOperationSchema = limitedOperation(
  z.discriminatedUnion("action", [
    z
      .object({
        action: z.literal("add"),
        name: databaseIdentifierSchema.describe("The new database name."),
        username: databaseIdentifierSchema.describe(
          "The new database user's name.",
        ),
        password: passwordSchema.describe(
          "The new database user's password. This is write-only.",
        ),
      })
      .strict(),
    z
      .object({
        action: z.literal("delete"),
        name: databaseIdentifierSchema.describe(
          "An existing database owned by this website.",
        ),
      })
      .strict(),
  ]),
);

const brokerDomainPattern =
  /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

const subjectAlternativeNamesSchema = z
  .string()
  .max(5_079)
  .superRefine((value, context) => {
    const names = value
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    if (names.length > 20)
      context.addIssue({
        code: "custom",
        message: "Use no more than 20 alternative domain names.",
      });
    names.forEach((name, index) => {
      if (!brokerDomainPattern.test(name))
        context.addIssue({
          code: "custom",
          path: [index],
          message: `${name || "This value"} is not a valid domain name.`,
        });
    });
  })
  .describe(
    "Optional comma-separated alternative domains. The primary domain is always included.",
  );

const certificateOperationSchema = limitedOperation(
  z.discriminatedUnion("action", [
    z
      .object({
        action: z.literal("lets-encrypt"),
        subjectAlternativeName: subjectAlternativeNamesSchema.optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("set-default"),
        id: resourceIdSchema.describe("The installed certificate to activate."),
      })
      .strict(),
  ]),
);

const sectionTextSchema = z
  .string()
  .min(1)
  .max(MAX_UNTYPED_OPERATION_BYTES)
  .refine(noNul, "The value cannot contain NUL bytes.");

const basicAuthOperationSchema = z
  .object({
    action: z.literal("basic-auth"),
    active: z.boolean(),
    username: z.string().min(1).max(255).refine(noControlCharacters),
    password: z
      .string()
      .max(1_024)
      .refine(noControlCharacters)
      .optional()
      .describe(
        "A new password. Omit it to retain the current password when already configured.",
      ),
  })
  .strict();

const securityOperationSchema = limitedOperation(
  z.discriminatedUnion("action", [
    z
      .object({ action: z.literal("add-ip"), value: sectionTextSchema })
      .strict(),
    z
      .object({ action: z.literal("delete-ip"), value: sectionTextSchema })
      .strict(),
    z
      .object({ action: z.literal("add-bot"), value: sectionTextSchema })
      .strict(),
    z
      .object({ action: z.literal("delete-bot"), value: sectionTextSchema })
      .strict(),
    basicAuthOperationSchema,
    z
      .object({ action: z.literal("cloudflare"), enabled: z.boolean() })
      .strict(),
  ]),
);

const linuxUsernameSchema = z
  .string()
  .regex(/^[a-z_][a-z0-9_-]{0,31}$/)
  .describe("A lowercase Linux account name of up to 32 characters.");

const accessUserOperationSchema = limitedOperation(
  z.discriminatedUnion("action", [
    z.object({ action: z.literal("generate-keypair") }).strict(),
    z
      .object({
        action: z.literal("add-ssh"),
        username: linuxUsernameSchema,
        password: passwordSchema,
        sshKeys: z
          .string()
          .max(64 * 1024)
          .refine(noNul, "SSH keys cannot contain NUL bytes.")
          .optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("delete-ssh"),
        username: linuxUsernameSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("add-ftp"),
        username: linuxUsernameSchema,
        password: passwordSchema,
        homeDirectory: pathSchema
          .refine((value) => value.startsWith("/home/"), {
            message: "FTP home directories must stay under /home.",
          })
          .optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("delete-ftp"),
        username: linuxUsernameSchema,
      })
      .strict(),
  ]),
);

const fileContentSchema = z
  .string()
  .max(MAX_FILE_READ_BYTES)
  .describe(
    `Text content of up to ${MAX_FILE_READ_BYTES} bytes, matching the File Manager editing limit.`,
  );

const archiveNameSchema = filenameSchema.refine(
  (value) => /\.(zip|7z|rar|tar\.gz|tgz)$/i.test(value),
  "Archive names must end in .zip, .7z, .rar, .tar.gz, or .tgz.",
);

const existingArchiveNameSchema = filenameSchema.refine(
  (value) => /\.(zip|7z|rar|tar\.gz|tgz)$/i.test(value),
  "Only .zip, .7z, .rar, .tar.gz, or .tgz archives can be extracted.",
);

const fileManagerOperationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), path: pathSchema }).strict(),
  z
    .object({
      action: z.literal("read"),
      path: requiredPathSchema,
      encoding: z.literal("base64").optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("paste"),
      path: pathSchema.describe("The destination folder."),
      source: requiredPathSchema,
      mode: z.enum(["copy", "cut"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("new-file"),
      path: pathSchema,
      name: filenameSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("new-folder"),
      path: pathSchema,
      name: filenameSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("upload"),
      path: pathSchema,
      name: filenameSchema,
      content: z
        .string()
        .max(MAX_FILE_UPLOAD_BASE64_BYTES)
        .describe("Base64 file content for a file of up to 64 MiB."),
    })
    .strict(),
  z
    .object({
      action: z.literal("save-file"),
      path: pathSchema,
      name: filenameSchema,
      content: fileContentSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("rename"),
      path: pathSchema,
      name: filenameSchema,
      newName: filenameSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("duplicate"),
      path: pathSchema,
      name: filenameSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("chmod"),
      path: pathSchema,
      name: filenameSchema,
      mode: z.string().regex(/^[0-7]{3,4}$/),
    })
    .strict(),
  z
    .object({
      action: z.literal("compress"),
      path: pathSchema,
      name: filenameSchema,
      archiveName: archiveNameSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("extract"),
      path: pathSchema,
      name: existingArchiveNameSchema,
      extractTo: pathSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("delete"),
      path: pathSchema,
      name: filenameSchema,
    })
    .strict(),
]);

const gitPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(noNul, "Git paths cannot contain NUL bytes.");
const gitBranchSchema = z
  .union([z.string().regex(/^[A-Za-z0-9._\/-]{1,200}$/), z.literal("")])
  .optional();
const gitRemoteSchema = z
  .string()
  .min(1)
  .max(1000)
  .regex(/^(https:\/\/|git@)\S+$/)
  .refine(noNul, "Git remote URLs cannot contain NUL bytes.");

const gitOperationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("clone"),
      url: gitRemoteSchema,
      branch: gitBranchSchema,
    })
    .strict(),
  z.object({ action: z.literal("init") }).strict(),
  z.object({ action: z.literal("set-remote"), url: gitRemoteSchema }).strict(),
  z.object({ action: z.literal("fetch") }).strict(),
  z.object({ action: z.literal("pull"), branch: gitBranchSchema }).strict(),
  z.object({ action: z.literal("push"), branch: gitBranchSchema }).strict(),
  z
    .object({
      action: z.literal("checkout"),
      branch: z.string().regex(/^[A-Za-z0-9._\/-]{1,200}$/),
    })
    .strict(),
  z
    .object({
      action: z.literal("commit"),
      message: z.string().trim().min(1).max(500),
    })
    .strict(),
  z.object({ action: z.literal("diff"), path: gitPathSchema }).strict(),
  z.object({ action: z.literal("discard"), path: gitPathSchema }).strict(),
  z.object({ action: z.literal("discard-all") }).strict(),
]);

const operationScriptSchema = z.string().regex(/^[A-Za-z0-9:._-]{1,64}$/);
const operationProcessSchema = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/);

const runOperationSchema = z
  .object({
    action: z.literal("run"),
    command: z.enum(operationCommands),
    script: operationScriptSchema.optional(),
    name: operationProcessSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const needsScript =
      value.command === "node-run" || value.command === "npm-run";
    const needsName = [
      "pm2-restart-one",
      "pm2-stop-one",
      "pm2-delete-one",
      "prepare-rootless-migration",
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

const actionsOperationSchema = z.union([
  runOperationSchema,
  z
    .object({
      action: z.literal("deploy"),
      plan: z.enum(["compose", "node", "static-build", "php", "python"]),
    })
    .strict(),
  z
    .object({ action: z.literal("fix"), fix: z.enum(operationFixCommands) })
    .strict(),
]);

const envEntrySchema = z
  .object({
    key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
    value: z
      .string()
      .max(4096)
      .refine(
        (value) => !/[\0\r\n]/.test(value),
        "Environment values cannot contain line breaks.",
      ),
  })
  .strict();

const envOperationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("save"),
      file: z.enum([".env", ".env.local", ".env.production"]),
      entries: z.array(envEntrySchema).max(200),
      syncProfile: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("upsert"),
      entries: z.array(envEntrySchema).min(1).max(50),
    })
    .strict(),
]);

const terminalOperationSchema = z
  .object({
    action: z.literal("exec"),
    command: z
      .string()
      .min(1)
      .max(4000)
      .refine(noNul, "Commands cannot contain NUL bytes."),
    cwd: z.string().max(512).optional(),
  })
  .strict();

const backupDatabaseSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const backupIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const backupOperationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      files: z.boolean().optional(),
      databases: z.array(backupDatabaseSchema).max(50).optional(),
      note: z.string().max(200).optional(),
    })
    .strict(),
  z.object({ action: z.literal("delete"), id: backupIdSchema }).strict(),
  z
    .object({
      action: z.literal("restore"),
      id: backupIdSchema,
      scope: z.enum(["all", "files", "databases"]).optional(),
    })
    .strict(),
]);

function cronCommands(value: string) {
  return value
    .split(/\r\n|[\n\r\v\f\x85\u2028\u2029]/)
    .map((command) => command.trim())
    .filter(Boolean);
}

const cronCommandSchema = z.string().superRefine((value, context) => {
  const commands = cronCommands(value);
  if (!commands.length || commands.length > 20)
    context.addIssue({
      code: "custom",
      message: "Use between 1 and 20 non-empty command lines.",
    });
  if (Buffer.byteLength(commands.join(" && "), "utf8") > 10_000)
    context.addIssue({
      code: "custom",
      message: "The combined cron command must be 10,000 bytes or smaller.",
    });
});

const cronOperationSchema = limitedOperation(
  z.discriminatedUnion("action", [
    z
      .object({
        action: z.literal("add"),
        schedule: z
          .string()
          .refine(
            (value) => value.trim().split(/\s+/).length === 5,
            "A cron schedule must contain exactly five fields.",
          ),
        command: cronCommandSchema,
      })
      .strict(),
    z.object({ action: z.literal("delete"), id: resourceIdSchema }).strict(),
  ]),
);

const logOperationSchema = limitedOperation(
  z.discriminatedUnion("action", [
    z.object({ action: z.literal("read"), name: requiredPathSchema }).strict(),
    z.object({ action: z.literal("clear"), name: requiredPathSchema }).strict(),
  ]),
);

const sectionInput = <const Section extends string, T extends z.ZodType>(
  section: Section,
  operation: T,
  description: string,
) =>
  z
    .object({
      domain: domainSchema,
      section: z.literal(section).describe(description),
      operation,
    })
    .strict();

/**
 * Typed input for the generic MCP website-area tool. The outer discriminator
 * correlates every section with only the operations that its existing UI,
 * route, and allow-listed CloudPanel bridge support.
 */
export const siteSectionToolSchema = z
  .discriminatedUnion("section", [
    sectionInput(
      "actions",
      actionsOperationSchema,
      "Deployments and safe operations.",
    ),
    sectionInput("vhost", vhostOperationSchema, "NGINX vhost configuration."),
    sectionInput("databases", databaseOperationSchema, "Website databases."),
    sectionInput(
      "certificates",
      certificateOperationSchema,
      "TLS certificates. Use the dedicated domain/SSL tool for orchestration.",
    ),
    sectionInput(
      "security",
      securityOperationSchema,
      "Website access controls.",
    ),
    sectionInput(
      "users",
      accessUserOperationSchema,
      "SSH and FTP access users.",
    ),
    sectionInput("file-manager", fileManagerOperationSchema, "Website files."),
    sectionInput("git", gitOperationSchema, "The website Git repository."),
    sectionInput("env", envOperationSchema, "Managed environment files."),
    sectionInput(
      "terminal",
      terminalOperationSchema,
      "Unprivileged website terminal.",
    ),
    sectionInput(
      "backups",
      backupOperationSchema,
      "On-server website backups.",
    ),
    sectionInput("cron-jobs", cronOperationSchema, "Website cron jobs."),
    sectionInput("logs", logOperationSchema, "Website log files."),
  ])
  .refine((value) => {
    const maximumBytes = UNTYPED_SECTION_LIMITS.get(value.section);
    return (
      maximumBytes === undefined ||
      Buffer.byteLength(JSON.stringify(value.operation), "utf8") <= maximumBytes
    );
  }, "The operation is too large for this website area.")
  .describe(
    "Run one typed action in an existing Panelavo website area. Inspect the area first and use its returned IDs and names.",
  );

export type SiteSectionToolInput = z.infer<typeof siteSectionToolSchema>;
