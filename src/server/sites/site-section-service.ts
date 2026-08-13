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

const untypedOperationSchema = z
  .record(z.unknown())
  .refine(
    (value) => typeof value.action === "string" && value.action.length > 0,
    {
      message: "An action is required.",
    },
  );

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

async function assertSectionAvailable(domain: string, section: string) {
  const meta = await getSiteMeta(domain);
  if (meta?.parent && !SERVICE_SECTIONS.has(section))
    throw new AppError(
      "INVALID_REQUEST",
      "That tool belongs to the parent website, not this linked service.",
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
  const input =
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
  const operation =
    section === "git" && input.action === "pull"
      ? { ...input, deployOperations: await getDeployHooks(domain) }
      : input;
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
    );
  } finally {
    release();
  }
}
