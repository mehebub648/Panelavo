import { getFleetState } from "@/server/fleet/store";
import { getPanelPublicDomain } from "@/server/sites/panel-self";
import { z } from "zod";
import {
  deploymentRequestSchema,
  gitReference,
  healthPathSchema,
  idempotencyKeySchema,
} from "@/lib/deployment";
import {
  deployHooksSchema,
  getDeployHooks,
  setDeployHooks,
} from "@/server/deploy/hooks";
import { jsonStore } from "@/server/storage/json-store";
import {
  accessibleSiteForActor,
  canWriteSites,
  writableSiteForActor,
  type PanelActor,
} from "@/server/auth/site-access";
import { decorateUser } from "@/server/auth/panel-roles";
import { listUserSessions } from "@/server/auth/session";
import {
  assertDeploymentTokenActive,
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from "@/server/auth/api-tokens";
import { AppError } from "@/server/cloudpanel/errors";
import {
  listSiteJobs,
  startBackgroundJob,
} from "@/server/jobs/background-jobs";
import { assertDiskGrowthAllowed } from "@/server/system/storage-hygiene";
import { getSiteMeta } from "@/server/sites/site-meta";
import type { RawOperationsData } from "@/types/operations";

export const deploymentSettingsSchema = z
  .object({
    branch: z.union([gitReference, z.literal("")]).default(""),
    healthPath: healthPathSchema.default("/"),
    automationEnabled: z.boolean().default(false),
    hooks: deployHooksSchema,
  })
  .strict();
type Settings = z.infer<typeof deploymentSettingsSchema>;
type StoredSettings = Omit<Settings, "hooks"> & { siteId: string };
const settingsStore = jsonStore<{ sites: Record<string, StoredSettings> }>(
  "deployment-settings.json",
  () => ({ sites: {} }),
  (value) =>
    z
      .object({
        sites: z.record(
          deploymentSettingsSchema
            .omit({ hooks: true })
            .extend({ siteId: z.string() }),
        ),
      })
      .parse(value),
  true,
);
let settingsQueue: Promise<unknown> = Promise.resolve();

async function storedSettings(
  domain: string,
  siteId: string,
): Promise<Settings> {
  const value = (await settingsStore.load()).sites[domain.toLowerCase()];
  return {
    branch: value?.siteId === siteId ? value.branch : "",
    healthPath: value?.siteId === siteId ? value.healthPath : "/",
    automationEnabled:
      value?.siteId === siteId ? value.automationEnabled : false,
    hooks: await getDeployHooks(domain),
  };
}

async function deploymentAccess(
  actor: PanelActor,
  domain: string,
  write = true,
) {
  const access = write
    ? await writableSiteForActor(actor, domain)
    : await accessibleSiteForActor(actor, domain);
  if ((await getSiteMeta(domain))?.parent)
    throw new AppError(
      "INVALID_REQUEST",
      "Deploy from the parent website.",
      409,
    );
  return access;
}

export async function getDeploymentSettings(actor: PanelActor, domain: string) {
  const { client, site } = await deploymentAccess(actor, domain);
  const [settings, runtime, git] = await Promise.all([
    storedSettings(domain, String(site.id)),
    client.getSiteSection(
      actor.cloudPanel,
      domain,
      "actions",
    ) as Promise<RawOperationsData>,
    client.getSiteSection(actor.cloudPanel, domain, "git") as Promise<{
      branch?: string;
    }>,
  ]);
  return { ...settings, branch: settings.branch || git.branch || "", runtime };
}

export async function saveDeploymentSettings(
  actor: PanelActor,
  domain: string,
  input: unknown,
) {
  const { client, site } = await deploymentAccess(actor, domain);
  const settings = deploymentSettingsSchema.parse(input);
  if (settings.automationEnabled && !settings.branch)
    throw new AppError(
      "INVALID_REQUEST",
      "Choose a deployment branch before enabling automatic deployment.",
      400,
    );
  await client.manageSiteSection(actor.cloudPanel, domain, "actions", {
    action: "validate-deployment",
    healthPath: settings.healthPath,
    deployOperations: settings.hooks,
  });
  const save = settingsQueue.then(async () => {
    const value = await settingsStore.load();
    value.sites[domain.toLowerCase()] = {
      branch: settings.branch,
      healthPath: settings.healthPath,
      automationEnabled: settings.automationEnabled,
      siteId: String(site.id),
    };
    await setDeployHooks(domain, settings.hooks);
    await settingsStore.save(value);
  });
  settingsQueue = save.catch(() => undefined);
  await save;
  return settings;
}

export async function listDeployments(actor: PanelActor, domain: string) {
  const { site } = await deploymentAccess(actor, domain, false);
  const jobs = await listSiteJobs(String(site.id), domain);
  if (canWriteSites(actor.user)) return { jobs };
  return {
    jobs: jobs.map(({ id, kind, status, createdAt, finishedAt }) => ({
      id,
      kind,
      status,
      createdAt,
      finishedAt,
    })),
  };
}

export async function getDeployment(
  actor: PanelActor,
  domain: string,
  id: string,
) {
  const { jobs } = await listDeployments(actor, domain);
  const job = jobs.find((item) => item.id === id);
  if (!job) throw new AppError("SITE_NOT_FOUND", "Deployment not found.", 404);
  return job;
}

export async function startDeployment(
  actor: PanelActor,
  domain: string,
  submitted: unknown,
  key: unknown,
) {
  const input = deploymentRequestSchema.parse(submitted);
  const idempotencyKey = idempotencyKeySchema.parse(key);
  const { site } = await deploymentAccess(actor, domain);
  const settings = await storedSettings(domain, String(site.id));
  if (
    actor.authentication === "api-token" &&
    (!settings.automationEnabled ||
      input.source !== "latest" ||
      !input.expectedCommit)
  )
    throw new AppError(
      "FORBIDDEN",
      "Enable automatic deployment and submit the tested commit.",
      403,
    );
  if (settings.branch && input.branch && input.branch !== settings.branch)
    throw new AppError(
      "INVALID_REQUEST",
      "Deployments must use the configured branch.",
      409,
    );
  const request = {
    ...input,
    branch: settings.branch || input.branch,
    settings,
  };
  return startBackgroundJob(
    actor,
    {
      domain,
      siteId: String(site.id),
      access: "site",
      kind:
        input.source === "latest"
          ? "Deploy latest changes"
          : "Deploy current files",
      cancellable: false,
      timeoutSeconds: 1800,
      idempotencyKey,
      request,
    },
    async ({ signal, progress }) => {
      const access = await deploymentAccess(actor, domain);
      const user = await decorateUser(
        await access.client.getCurrentUser(actor.cloudPanel),
      );
      if (
        String(user.id) !== String(actor.user.id) ||
        user.status === false ||
        String(access.site.id) !== String(site.id)
      )
        throw new AppError(
          "FORBIDDEN",
          "The website or account changed before deployment started.",
          403,
        );
      const liveActor = { ...actor, user };
      await deploymentAccess(liveActor, domain);
      if (
        actor.authentication === "session" &&
        !(await listUserSessions(user.username, actor.credentialId ?? "")).some(
          (session) => session.id === actor.credentialId,
        )
      )
        throw new AppError(
          "SESSION_EXPIRED",
          "Your session ended before deployment started.",
          401,
        );
      if (actor.authentication === "api-token")
        await assertDeploymentTokenActive(
          actor.credentialId ?? "",
          String(user.id),
          String(site.id),
        );
      if (
        actor.authentication === "fleet" &&
        !(await getFleetState()).nodeLinks.some(
          (link) =>
            link.connectionId === actor.credentialId &&
            String(link.owner.id) === String(user.id) &&
            ["online", "degraded"].includes(link.status),
        )
      )
        throw new AppError(
          "FORBIDDEN",
          "The connected-server authorization is no longer active.",
          403,
        );
      await assertDiskGrowthAllowed();
      return access.client.manageSiteSection(
        actor.cloudPanel,
        domain,
        "actions",
        {
          action: "deployment",
          source: input.source,
          branch: request.branch,
          expectedCommit: input.expectedCommit,
          healthPath: settings.healthPath,
          deployOperations: settings.hooks,
        },
        { signal, onProgress: progress },
      );
    },
  );
}

export async function manageDeploymentTokens(
  actor: PanelActor,
  domain: string,
  input: unknown = { action: "list" },
) {
  const { site } = await deploymentAccess(actor, domain);
  if (!["session", "fleet"].includes(actor.authentication))
    throw new AppError(
      "FORBIDDEN",
      "Manage deployment tokens from the browser.",
      403,
    );
  const operation = z
    .discriminatedUnion("action", [
      z.object({ action: z.literal("list") }).strict(),
      z
        .object({
          action: z.literal("create"),
          name: z.string().trim().min(1).max(80).default("CI deployment"),
        })
        .strict(),
      z.object({ action: z.literal("revoke"), id: z.string().uuid() }).strict(),
    ])
    .parse(input);
  const tokens = (await listApiTokens(actor.user.username)).filter(
    (token) =>
      token.deployment?.siteId === String(site.id) &&
      token.deployment.ownerUserId === String(actor.user.id),
  );
  if (operation.action === "list")
    return {
      tokens,
      endpoint: `https://${getPanelPublicDomain()}/api/v1/sites/${encodeURIComponent(domain)}/deployments`,
    };
  if (operation.action === "revoke") {
    if (!tokens.some((token) => token.id === operation.id))
      throw new AppError("SITE_NOT_FOUND", "Token not found.", 404);
    await revokeApiToken(actor.user.username, operation.id);
    return { tokens: tokens.filter((token) => token.id !== operation.id) };
  }
  return createApiToken(actor.user.username, {
    name: operation.name,
    scopes: ["deployments:write"],
    expiresInDays: 90,
    deployment: {
      siteId: String(site.id),
      domain: domain.toLowerCase(),
      ownerUserId: String(actor.user.id),
    },
  });
}
