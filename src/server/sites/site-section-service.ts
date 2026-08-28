import { z } from "zod";
import { SERVICE_SECTIONS, isSiteSection } from "@/lib/site-sections";
import {
  backupRequestSchema,
  envRequestSchema,
  gitRequestSchema,
  operationsRequestSchema,
  terminalRequestSchema,
} from "@/schemas/operations";
import type { PanelActor } from "@/server/auth/site-access";
import {
  accessibleSiteForActor,
  writableSiteForActor,
} from "@/server/auth/site-access";
import { AppError } from "@/server/cloudpanel/errors";
import { getDeployHooks } from "@/server/deploy/hooks";
import { getSiteMeta } from "@/server/sites/site-meta";
import { assertDiskGrowthAllowed } from "@/server/system/storage-hygiene";
import type { SiteSectionExecutionOptions } from "@/types/cloudpanel";

const untypedOperationSchema = z
  .record(z.unknown())
  .refine(
    (value) => typeof value.action === "string" && value.action.length > 0,
    {
      message: "An action is required.",
    },
  );

const databaseExposureSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("exposure-create"),
      name: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{1,49}$/),
      label: z.string().regex(/^(?!-)[a-z0-9-]{3,40}(?<!-)$/),
      permissions: z.enum(["ro", "rw"]),
      accessMode: z.enum(["allowlist", "internet"]),
      allowlist: z.array(z.string().min(2).max(64)).max(32),
      currentPassword: z.string().min(1).max(256),
      confirmation: z.string().min(1).max(253),
    })
    .strict(),
  z
    .object({
      action: z.literal("exposure-update"),
      name: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{1,49}$/),
      permissions: z.enum(["ro", "rw"]),
      accessMode: z.enum(["allowlist", "internet"]),
      allowlist: z.array(z.string().min(2).max(64)).max(32),
      currentPassword: z.string().min(1).max(256),
      confirmation: z.string().min(1).max(253),
    })
    .strict(),
  z
    .object({
      action: z.enum(["exposure-rotate", "exposure-revoke"]),
      name: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{1,49}$/),
      currentPassword: z.string().min(1).max(256),
      confirmation: z.string().min(1).max(253),
    })
    .strict(),
]);

function parseUntypedOperation(section: string, submitted: unknown) {
  const operation = untypedOperationSchema.parse(submitted);
  const maximumBytes =
    section === "file-manager" ? 90 * 1024 * 1024 : 128 * 1024;
  if (Buffer.byteLength(JSON.stringify(operation)) > maximumBytes)
    throw new AppError(
      "INVALID_REQUEST",
      section === "file-manager"
        ? "The file operation is too large. Uploads must be 64 MiB or smaller."
        : "The operation is too large.",
      400,
    );
  return operation;
}

const LONG_RUNNING_SECTIONS = new Set([
  "actions",
  "backups",
  "git",
  "terminal",
]);

type InFlightOperation = {
  actorId: string;
  domain: string;
  section: string;
  action: string;
  expiresAt: number;
};

const inFlightOperations = new Map<string, InFlightOperation>();

function operationKey(actor: PanelActor, domain: string, section: string) {
  return `${actor.user.id}:${domain.toLowerCase()}:${section}`;
}

function acquireOperation(
  actor: PanelActor,
  domain: string,
  section: string,
  action: string,
) {
  if (!LONG_RUNNING_SECTIONS.has(section)) return () => undefined;
  const key = operationKey(actor, domain, section);
  const current = inFlightOperations.get(key);
  if (current && current.expiresAt > Date.now())
    throw new AppError(
      "OPERATION_BUSY",
      `A ${current.section} ${current.action} request is already running for this website. Wait for it to finish before retrying.`,
      409,
    );
  inFlightOperations.set(key, {
    actorId: actor.user.id,
    domain,
    section,
    action,
    expiresAt: Date.now() + 31 * 60_000,
  });
  return () => inFlightOperations.delete(key);
}

function assertSection(section: string) {
  if (!isSiteSection(section))
    throw new AppError(
      "INVALID_REQUEST",
      "That website section is not available.",
      400,
    );
}

const STORAGE_GROWING_ACTIONS: Record<string, Set<string>> = {
  actions: new Set(["deploy", "fix"]),
  backups: new Set(["create", "restore"]),
  databases: new Set(["create", "import"]),
  "file-manager": new Set([
    "compress",
    "duplicate",
    "extract",
    "new-file",
    "new-folder",
    "paste",
    "save-file",
    "upload",
  ]),
  git: new Set(["checkout", "clone", "fetch", "pull"]),
};

const STORAGE_GROWING_OPERATION_COMMANDS = new Set([
  "artisan-migrate",
  "composer-install",
  "composer-install-production",
  "compose-deploy",
  "compose-pull",
  "compose-up",
  "cutover-rootless-migration",
  "django-collectstatic",
  "django-migrate",
  "node-install",
  "node-run",
  "npm-ci",
  "npm-install",
  "npm-run",
  "pip-install",
  "prepare-rootless-migration",
  "python-create-venv",
  "python-install",
]);

function mayGrowStorage(
  section: string,
  input: unknown,
) {
  if (!input || typeof input !== "object") return false;
  const operation = input as { action?: unknown; command?: unknown };
  const action = String(operation.action ?? "");
  if (section === "actions" && action === "run")
    return (
      typeof operation.command === "string" &&
      STORAGE_GROWING_OPERATION_COMMANDS.has(operation.command)
    );
  return STORAGE_GROWING_ACTIONS[section]?.has(action) ?? false;
}

async function assertSectionAvailable(domain: string, section: string) {
  const meta = await getSiteMeta(domain);
  if (meta?.parent && !SERVICE_SECTIONS.has(section))
    throw new AppError(
      "INVALID_REQUEST",
      "That tool belongs to the parent website, not this project endpoint.",
      409,
    );
}

export async function getSiteSectionForActor(
  actor: PanelActor,
  domain: string,
  section: string,
) {
  assertSection(section);
  const access =
    section === "env"
      ? await writableSiteForActor(actor, domain)
      : await accessibleSiteForActor(actor, domain);
  await assertSectionAvailable(domain, section);
  if (section === "settings") return access.site;
  return access.client.getSiteSection(actor.cloudPanel, domain, section);
}

export async function manageSiteSectionForActor(
  actor: PanelActor,
  domain: string,
  section: string,
  submitted: unknown,
  execution?: SiteSectionExecutionOptions,
) {
  assertSection(section);
  if (section === "settings")
    throw new AppError(
      "INVALID_REQUEST",
      "Use the website settings tool for this section.",
      400,
    );
  const { client } = await writableSiteForActor(actor, domain);
  await assertSectionAvailable(domain, section);
  const submittedAction =
    submitted && typeof submitted === "object" && "action" in submitted
      ? String((submitted as { action?: unknown }).action ?? "")
      : "";
  const databaseExposure =
    section === "databases" && submittedAction.startsWith("exposure-");
  if (databaseExposure && actor.authentication !== "session")
    throw new AppError(
      "FORBIDDEN",
      "Public database endpoints can only be changed from the Panelavo browser interface.",
      403,
    );
  const input = databaseExposure
    ? databaseExposureSchema.parse(submitted)
    :
    section === "git"
      ? gitRequestSchema.parse(submitted)
      : section === "actions"
        ? operationsRequestSchema.parse(submitted)
        : section === "env"
          ? envRequestSchema.parse(submitted)
          : section === "terminal"
            ? terminalRequestSchema.parse(submitted)
            : section === "backups"
              ? backupRequestSchema.parse(submitted)
              : parseUntypedOperation(section, submitted);
  let securedInput: typeof input | Record<string, unknown> = input;
  if (mayGrowStorage(section, input))
    await assertDiskGrowthAllowed();
  if (databaseExposure) {
    const exposure = input as z.infer<typeof databaseExposureSchema>;
    await client.verifyPassword(actor.cloudPanel, exposure.currentPassword);
    const safeExposure = { ...exposure } as Record<string, unknown>;
    delete safeExposure.currentPassword;
    securedInput = safeExposure;
  }
  const operation =
    section === "git" && input.action === "pull"
      ? { ...input, deployOperations: await getDeployHooks(domain) }
      : securedInput;
  const release = acquireOperation(
    actor,
    domain,
    section,
    String(input.action),
  );
  try {
    return await client.manageSiteSection(
      actor.cloudPanel,
      domain,
      section,
      operation,
      execution,
    );
  } finally {
    release();
  }
}
