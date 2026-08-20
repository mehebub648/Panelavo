import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod4";
import { deployHookCommands } from "@/lib/deploy-hooks";
import { SITE_SECTIONS } from "@/lib/site-sections";
import { createSiteSchema, updateSiteSchema } from "@/schemas/sites";
import { operationCommands, operationFixCommands } from "@/schemas/operations";
import type { PanelActor } from "@/server/auth/site-access";
import {
  accessibleDomainTargetForActor,
  canWriteSites,
  writableSiteForActor,
} from "@/server/auth/site-access";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import {
  createMcpConfirmationManager,
  type McpConfirmationRequest,
} from "@/server/mcp/confirmation";
import {
  beginArtifactUpload,
  deleteArtifactUpload,
  getArtifactUpload,
} from "@/server/mcp/artifacts";
import {
  cancelMcpJob,
  getMcpJob,
  listMcpJobs,
  startMcpJob,
} from "@/server/mcp/jobs";
import { siteSectionToolSchema } from "@/server/mcp/site-section-tool-schema";
import { audit, auditContext } from "@/server/security/log";
import { rateLimit } from "@/server/security/request";
import { getServerPublicIp } from "@/server/network/server-ip";
import {
  createLinkedServiceForActor,
  listLinkedServicesForActor,
} from "@/server/sites/linked-service-service";
import {
  getSiteDnsForActor,
  getSiteDomainsForActor,
  manageSiteDomainsForActor,
  pointSiteDnsForActor,
} from "@/server/sites/site-domain-service";
import {
  getSiteBackupAutomationForActor,
  getSiteDeployHooksForActor,
  getSiteUptimeForActor,
  manageSiteOffsiteBackupForActor,
  removeSiteOffsiteDestinationForActor,
  saveSiteBackupScheduleForActor,
  saveSiteDeployHooksForActor,
  saveSiteOffsiteDestinationForActor,
  saveSiteUptimeForActor,
} from "@/server/sites/site-automation-service";
import {
  getSiteSectionForActor,
  manageSiteSectionForActor,
} from "@/server/sites/site-section-service";
import {
  createManagedSite,
  deleteManagedSite,
  getManagedSite,
  getSiteCreationDetails,
  listManagedSites,
  updateManagedSite,
} from "@/server/sites/site-service";
import { getPanelSelfDomain } from "@/server/sites/panel-self";

const domainSchema = z
  .string()
  .min(1)
  .max(253)
  .describe("The website's Panelavo system domain or visible domain.");
const readableSections = SITE_SECTIONS.filter(
  (section) => section !== "domains",
);

const siteDomainOperationToolSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add-alias"), domain: domainSchema }),
  z.object({ action: z.literal("remove-alias"), domain: domainSchema }),
  z.object({
    action: z.literal("set-block"),
    block: z.enum(["none", "error", "redirect"]),
    redirectTo: domainSchema.optional(),
  }),
  z.object({
    action: z.literal("issue-ssl"),
    domains: z.array(domainSchema).min(1).max(11),
  }),
  z.object({ action: z.literal("ensure-ssl") }),
]);

const linkedServiceToolSchema = z.object({
  domain: domainSchema.describe("The parent website's system domain."),
  serviceName: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z][a-z0-9-]*$/)
    .describe("A short label such as api, auth, or worker."),
  targetPort: z
    .number()
    .int()
    .min(1024)
    .max(65535)
    .describe("A loopback port exposed by the parent website's own stack."),
  aliases: z.array(domainSchema).max(10).default([]),
});

const uptimeToolSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(1).max(60),
});

const deployHookToolSchema = z
  .object({
    command: z.enum(deployHookCommands),
    script: z
      .string()
      .regex(/^[A-Za-z0-9:._-]{1,64}$/)
      .optional(),
    name: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,100}$/)
      .optional(),
  })
  .superRefine((value, context) => {
    const needsScript =
      value.command === "node-run" || value.command === "npm-run";
    const needsName = value.command === "pm2-restart-one";
    if (needsScript !== Boolean(value.script))
      context.addIssue({
        code: "custom",
        path: ["script"],
        message: needsScript
          ? "This operation needs a package script."
          : "This operation does not accept a package script.",
      });
    if (needsName !== Boolean(value.name))
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: needsName
          ? "This operation needs a PM2 process name."
          : "This operation does not accept a PM2 process name.",
      });
  });

const backupScheduleToolSchema = z.discriminatedUnion("frequency", [
  z.object({
    enabled: z.boolean(),
    frequency: z.literal("daily"),
    hour: z.number().int().min(0).max(23),
    retention: z.number().int().min(1).max(100),
  }),
  z.object({
    enabled: z.boolean(),
    frequency: z.literal("weekly"),
    hour: z.number().int().min(0).max(23),
    weekday: z.number().int().min(0).max(6),
    retention: z.number().int().min(1).max(100),
  }),
]);

const offsiteDestinationToolSchema = z.object({
  enabled: z.boolean(),
  endpoint: z.string().url().max(500).startsWith("https://"),
  region: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  bucket: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/),
  prefix: z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9._/-]*$/),
  accessKeyId: z.string().min(1).max(256),
  secretAccessKey: z
    .string()
    .max(512)
    .default("")
    .describe("Leave empty only when keeping the currently saved secret."),
  forcePathStyle: z.boolean().default(false),
});

const createSiteToolSchema = z.object({
  type: z.enum([
    "php",
    "nodejs",
    "static",
    "python",
    "reverse-proxy",
    "docker",
  ]),
  category: z.string().min(1).max(32),
  aliases: z.array(z.string()).max(10).default([]),
  siteUserPassword: z.string().min(12).max(128),
  label: z.string().max(80).optional(),
  phpVersion: z.string().max(32).optional(),
  vhostTemplate: z.string().max(100).optional(),
  nodeVersion: z.string().max(32).optional(),
  pythonVersion: z.string().max(32).optional(),
  reverseProxyUrl: z.string().max(2048).optional(),
});

const updateSiteToolSchema = z.object({
  domain: domainSchema,
  applicationRootDirectory: z.string().max(200).optional(),
  servingDirectory: z.string().max(200).optional(),
  runtimeVersion: z.string().max(32).optional(),
  appPort: z.number().int().min(1024).max(65535).optional(),
  reverseProxyUrl: z.string().max(2048).optional(),
  label: z.string().max(80).optional(),
});

const artifactIdSchema = z
  .string()
  .uuid()
  .describe("The artifact upload ID returned by Panelavo.");

const jobIdSchema = z
  .string()
  .uuid()
  .describe("The background job ID returned by Panelavo.");

const jobOperationSchema = z
  .object({
    kind: z.literal("operation"),
    command: z.enum(operationCommands).optional(),
    fix: z.enum(operationFixCommands).optional(),
    script: z.string().max(64).optional(),
    name: z.string().max(100).optional(),
  })
  .refine((value) => Boolean(value.command) !== Boolean(value.fix), {
    message: "Choose exactly one operation command or repair.",
  });

const startJobToolSchema = z.object({
  domain: domainSchema,
  timeoutSeconds: z.number().int().min(30).max(1_800).default(1_800),
  job: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("deploy"),
      plan: z.enum(["compose", "node", "static-build", "php", "python"]),
    }),
    z.object({
      kind: z.literal("backup"),
      files: z.boolean().default(true),
      databases: z.array(z.string().max(64)).max(50).optional(),
      note: z.string().max(200).optional(),
    }),
    jobOperationSchema,
  ]),
});

const beginArtifactUploadToolSchema = z.object({
  domain: domainSchema,
  name: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^/\\\x00]+$/)
    .describe("The archive or artifact filename, without a directory path."),
  expectedBytes: z.number().int().min(1).max(2 * 1024 * 1024 * 1024),
  expectedSha256: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/)
    .describe("The lowercase or uppercase SHA-256 digest of the complete file."),
  mediaType: z.string().max(200).optional(),
});

function result(value: unknown) {
  const structured =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { result: value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: structured,
  };
}

async function requireSiteActionConfirmation(
  actor: PanelActor,
  confirmation: ReturnType<typeof createMcpConfirmationManager>,
  request: McpConfirmationRequest & { domain: string },
) {
  await writableSiteForActor(actor, request.domain);
  return confirmation.require(request);
}

async function runTool<T>(
  actor: PanelActor,
  name: string,
  target: { type: string; id?: string },
  details: Record<string, unknown>,
  work: () => Promise<T>,
) {
  try {
    const value = await work();
    await audit(
      "mcp.tool.called",
      "success",
      auditContext({
        actor: actor.user,
        target,
        details: {
          tool: name,
          credentialId: actor.credentialId,
          ...details,
        },
      }),
    );
    return result(value);
  } catch (error) {
    await audit(
      "mcp.tool.called",
      "failure",
      auditContext({
        actor: actor.user,
        target,
        error,
        details: {
          tool: name,
          credentialId: actor.credentialId,
          ...details,
        },
      }),
    );
    throw error;
  }
}

type OperationSectionData = {
  plan?: { id?: string; status?: string };
  groups?: Array<{
    actions?: Array<{ id?: string; status?: string }>;
  }>;
  checks?: Array<{ fix?: { id?: string; status?: string } }>;
  preflight?: {
    status?: string;
    checks?: Array<{ fix?: { id?: string; status?: string } }>;
  };
};

function assertReadyOperation(
  data: unknown,
  kind: "plan" | "command" | "fix",
  id: string,
) {
  const operations = data as OperationSectionData;
  if (kind === "plan") {
    if (operations.plan?.id !== id || operations.plan?.status !== "ready")
      throw new AppError(
        "INVALID_REQUEST",
        `The ${id} deployment plan is not currently ready. Inspect Operations and resolve its blockers first.`,
        409,
      );
    return;
  }
  const action =
    kind === "fix"
      ? [...(operations.preflight?.checks ?? []), ...(operations.checks ?? [])]
          .map((check) => check.fix)
          .find((candidate) => candidate?.id === id)
      : (operations.groups ?? [])
          .flatMap((group) => group.actions ?? [])
          .find((candidate) => candidate.id === id);
  if (action?.status !== "ready")
    throw new AppError(
      "INVALID_REQUEST",
      `The ${id} operation is not currently ready. Inspect Operations and resolve its blockers first.`,
      409,
    );
}

export function createPanelavoMcpServer(actor: PanelActor) {
  const confirmationManager = createMcpConfirmationManager(actor);
  const server = new McpServer(
    { name: "Panelavo", version: "1.0.0" },
    {
      instructions:
        "Manage only the websites visible to this signed-in Panelavo user. Inspect before changing, prefer a backup before deployment, and ask for explicit confirmation before destructive or service-disrupting actions. Account security, user administration, and Panelavo settings remain UI-only.",
      requestState: { verify: confirmationManager.verifyRequestState },
    },
  );
  const canWrite = canWriteSites(actor.user);

  server.registerTool(
    "panelavo_whoami",
    {
      title: "Show my Panelavo access",
      description:
        "Show the live Panelavo role and effective website capabilities for this connection.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      runTool(
        actor,
        "panelavo_whoami",
        { type: "account", id: actor.user.id },
        {},
        async () => ({
          username: actor.user.username,
          displayName: actor.user.displayName,
          role: actor.user.panelRole,
          capabilities: {
            readWebsites: true,
            manageWebsites: canWrite,
            createWebsites: actor.user.canCreateSites,
            hostWebsiteRepairs: actor.user.panelRole === "super-admin",
          },
        }),
      ),
  );

  server.registerTool(
    "panelavo_list_sites",
    {
      title: "List my websites",
      description:
        "List every website this Panelavo user can currently access, including labels, categories, aliases, and uptime state.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      runTool(
        actor,
        "panelavo_list_sites",
        { type: "websites" },
        {},
        async () => ({
          sites: await listManagedSites(actor),
        }),
      ),
  );

  server.registerTool(
    "panelavo_get_site",
    {
      title: "Inspect a website",
      description:
        "Get the current Panelavo details for one accessible website.",
      inputSchema: z.object({ domain: domainSchema }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ domain }) =>
      runTool(
        actor,
        "panelavo_get_site",
        { type: "site", id: domain },
        {},
        () => getManagedSite(actor, domain),
      ),
  );

  server.registerTool(
    "panelavo_get_site_section",
    {
      title: "Inspect a website area",
      description:
        "Read a website area: operations, vhost, databases, certificates, security, access users, files, Git, environment, terminal context, backups, cron jobs, or logs. Use the dedicated website-domains tool for domains, DNS, and SSL state. Environment values require website-write access.",
      inputSchema: z.object({
        domain: domainSchema,
        section: z.enum(readableSections),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ domain, section }) =>
      runTool(
        actor,
        "panelavo_get_site_section",
        { type: "site", id: domain },
        { section },
        () => getSiteSectionForActor(actor, domain, section),
      ),
  );

  server.registerTool(
    "panelavo_get_site_domains",
    {
      title: "Inspect website domains",
      description:
        "Show a website's system domain, visible aliases, system-domain redirect or block policy, public DNS status, and server IP.",
      inputSchema: z.object({ domain: domainSchema }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ domain }) =>
      runTool(
        actor,
        "panelavo_get_site_domains",
        { type: "site", id: domain },
        {},
        async () =>
          getSiteDomainsForActor(actor, domain, await getServerPublicIp()),
      ),
  );

  server.registerTool(
    "panelavo_get_site_dns",
    {
      title: "Inspect website DNS",
      description:
        "Check public DNS and available Cloudflare connection details for one system domain or visible alias belonging to an accessible website.",
      inputSchema: z.object({ domain: domainSchema }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ domain }) =>
      runTool(
        actor,
        "panelavo_get_site_dns",
        { type: "domain", id: domain },
        {},
        async () =>
          getSiteDnsForActor(actor, domain, await getServerPublicIp()),
      ),
  );

  server.registerTool(
    "panelavo_list_linked_services",
    {
      title: "List linked services",
      description:
        "List reverse-proxy services attached to an accessible parent website, including their domains, aliases, target URL, and live visibility.",
      inputSchema: z.object({ domain: domainSchema }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ domain }) =>
      runTool(
        actor,
        "panelavo_list_linked_services",
        { type: "site", id: domain },
        {},
        () => listLinkedServicesForActor(actor, domain),
      ),
  );

  server.registerTool(
    "panelavo_get_site_uptime",
    {
      title: "Inspect website uptime",
      description:
        "Show an accessible website's uptime-check settings and latest persisted health state.",
      inputSchema: z.object({ domain: domainSchema }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ domain }) =>
      runTool(
        actor,
        "panelavo_get_site_uptime",
        { type: "site", id: domain },
        {},
        () => getSiteUptimeForActor(actor, domain),
      ),
  );

  if (actor.user.canCreateSites) {
    server.registerTool(
      "panelavo_get_site_creation_options",
      {
        title: "Show website creation choices",
        description:
          "Get the live categories, runtimes, templates, base domain, and next IDs available before creating a website.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () =>
        runTool(
          actor,
          "panelavo_get_site_creation_options",
          { type: "websites" },
          {},
          () => getSiteCreationDetails(actor),
        ),
    );

    server.registerTool(
      "panelavo_create_site",
      {
        title: "Create a website",
        description:
          "Create a Panelavo website using a live creation option. Panelavo allocates its system domain, site user, and port, then configures aliases and SSL.",
        inputSchema: createSiteToolSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (input) =>
        runTool(
          actor,
          "panelavo_create_site",
          { type: "websites" },
          { siteType: input.type },
          () => {
            rateLimit(`mcp:site-create:${actor.user.id}`, 5, 10 * 60_000);
            return createManagedSite(actor, createSiteSchema.parse(input));
          },
        ),
    );
  }

  if (canWrite) {
    server.registerTool(
      "panelavo_begin_artifact_upload",
      {
        title: "Begin a resumable artifact upload",
        description:
          "Create a 24-hour binary upload session for a writable website. Upload raw chunks to the returned HTTPS URL with Content-Range; Panelavo resumes from the reported offset and accepts the artifact only after its complete SHA-256 checksum matches. This avoids base64 and supports files up to 2 GiB.",
        inputSchema: beginArtifactUploadToolSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ domain, ...input }) =>
        runTool(
          actor,
          "panelavo_begin_artifact_upload",
          { type: "site", id: domain },
          { bytes: input.expectedBytes },
          async () => {
            await writableSiteForActor(actor, domain);
            const upload = await beginArtifactUpload(actor, {
              domain,
              ...input,
            });
            const self = getPanelSelfDomain();
            return {
              ...upload,
              uploadUrl: self
                ? `https://${self}${upload.uploadPath}`
                : upload.uploadPath,
              protocol:
                "PUT raw binary chunks with Content-Range: bytes <start>-<end>/<total>; use HEAD or this status tool to resume from Upload-Offset.",
            };
          },
        ),
    );

    server.registerTool(
      "panelavo_get_artifact_upload",
      {
        title: "Inspect an artifact upload",
        description:
          "Return the accepted byte offset, checksum status, expiry, and resumable upload URL for an MCP artifact.",
        inputSchema: z.object({ artifactId: artifactIdSchema }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ artifactId }) =>
        runTool(
          actor,
          "panelavo_get_artifact_upload",
          { type: "artifact", id: artifactId },
          {},
          async () => {
            const upload = await getArtifactUpload(actor, artifactId);
            await writableSiteForActor(actor, upload.domain);
            const self = getPanelSelfDomain();
            return {
              ...upload,
              uploadUrl: self
                ? `https://${self}${upload.uploadPath}`
                : upload.uploadPath,
            };
          },
        ),
    );

    server.registerTool(
      "panelavo_delete_artifact_upload",
      {
        title: "Delete an artifact upload",
        description:
          "Delete one temporary MCP artifact without changing website files or releases.",
        inputSchema: z.object({ artifactId: artifactIdSchema }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ artifactId }) =>
        runTool(
          actor,
          "panelavo_delete_artifact_upload",
          { type: "artifact", id: artifactId },
          {},
          async () => {
            const upload = await getArtifactUpload(actor, artifactId);
            await writableSiteForActor(actor, upload.domain);
            return deleteArtifactUpload(actor, artifactId);
          },
        ),
    );

    server.registerTool(
      "panelavo_start_site_job",
      {
        title: "Start a background website job",
        description:
          "Queue a long deployment, backup, or allow-listed operation and return immediately with a job ID. Inspect progress and lifecycle logs with the job-status tool; cancellation stops the complete privileged process group.",
        inputSchema: startJobToolSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ domain, timeoutSeconds, job }, context) => {
        const label =
          job.kind === "deploy"
            ? `${job.plan} deployment`
            : job.kind === "backup"
              ? "backup"
              : String(job.fix ?? job.command);
        const confirmation = await requireSiteActionConfirmation(
          actor,
          confirmationManager,
          {
            context,
            domain,
            tool: "panelavo_start_site_job",
            arguments: { domain, timeoutSeconds, job },
            message: `Allow the AI assistant to start the ${label} background job for ${domain}? It may change or restart the live website and will be stopped after ${timeoutSeconds} seconds if unfinished.`,
          },
        );
        if (confirmation) return confirmation;
        return runTool(
          actor,
          "panelavo_start_site_job",
          { type: "site", id: domain },
          { kind: job.kind, timeoutSeconds },
          async () => {
            await writableSiteForActor(actor, domain);
            return startMcpJob(
              actor,
              { domain, kind: label, timeoutSeconds },
              async ({ signal, log }) => {
                if (job.kind === "deploy") {
                  await log("Checking the live Operations preflight.");
                  assertReadyOperation(
                    await getSiteSectionForActor(actor, domain, "actions"),
                    "plan",
                    job.plan,
                  );
                  await log(`Running the server-owned ${job.plan} plan.`);
                  return manageSiteSectionForActor(
                    actor,
                    domain,
                    "actions",
                    { action: "deploy", plan: job.plan },
                    { signal },
                  );
                }
                if (job.kind === "backup") {
                  await log("Creating the atomic local website snapshot.");
                  return manageSiteSectionForActor(
                    actor,
                    domain,
                    "backups",
                    { action: "create", ...job },
                    { signal },
                  );
                }
                const selected = job.fix ?? job.command!;
                await log("Checking that the requested operation is ready.");
                assertReadyOperation(
                  await getSiteSectionForActor(actor, domain, "actions"),
                  job.fix ? "fix" : "command",
                  selected,
                );
                await log(`Running the allow-listed ${selected} operation.`);
                return manageSiteSectionForActor(
                  actor,
                  domain,
                  "actions",
                  job.fix
                    ? { action: "fix", fix: job.fix }
                    : {
                        action: "run",
                        command: job.command,
                        script: job.script,
                        name: job.name,
                      },
                  { signal },
                );
              },
            );
          },
        );
      },
    );

    server.registerTool(
      "panelavo_get_site_job",
      {
        title: "Inspect a background website job",
        description:
          "Return one background job's status, bounded lifecycle logs, result summary, timeout, and error without waiting for it to finish.",
        inputSchema: z.object({ jobId: jobIdSchema }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ jobId }) =>
        runTool(
          actor,
          "panelavo_get_site_job",
          { type: "job", id: jobId },
          {},
          async () => {
            const job = await getMcpJob(actor, jobId);
            await writableSiteForActor(actor, job.domain);
            return job;
          },
        ),
    );

    server.registerTool(
      "panelavo_list_site_jobs",
      {
        title: "List background website jobs",
        description:
          "List the current MCP credential's recent background jobs for one writable website.",
        inputSchema: z.object({ domain: domainSchema }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ domain }) =>
        runTool(
          actor,
          "panelavo_list_site_jobs",
          { type: "site", id: domain },
          {},
          async () => {
            await writableSiteForActor(actor, domain);
            return listMcpJobs(actor, domain);
          },
        ),
    );

    server.registerTool(
      "panelavo_cancel_site_job",
      {
        title: "Cancel a background website job",
        description:
          "Request cancellation of one active background job. Panelavo kills the complete broker process group so child builds and deployment commands do not continue invisibly.",
        inputSchema: z.object({ jobId: jobIdSchema }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ jobId }, context) => {
        const job = await getMcpJob(actor, jobId);
        await writableSiteForActor(actor, job.domain);
        const confirmation = await requireSiteActionConfirmation(
          actor,
          confirmationManager,
          {
            context,
            domain: job.domain,
            tool: "panelavo_cancel_site_job",
            arguments: { jobId },
            message: `Cancel the active ${job.kind} job for ${job.domain}? Its complete server process group will be stopped.`,
          },
        );
        if (confirmation) return confirmation;
        return runTool(
          actor,
          "panelavo_cancel_site_job",
          { type: "job", id: jobId },
          { domain: job.domain },
          () => cancelMcpJob(actor, jobId),
        );
      },
    );

    server.registerTool(
      "panelavo_get_site_automation",
      {
        title: "Inspect website automation",
        description:
          "Show a writable website's after-pull deployment steps, local backup schedule, redacted off-site destination, and remote backup inventory.",
        inputSchema: z.object({ domain: domainSchema }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ domain }) =>
        runTool(
          actor,
          "panelavo_get_site_automation",
          { type: "site", id: domain },
          {},
          async () => {
            const [deployHooks, backups] = await Promise.all([
              getSiteDeployHooksForActor(actor, domain),
              getSiteBackupAutomationForActor(actor, domain),
            ]);
            return { deployHooks, backups };
          },
        ),
    );

    server.registerTool(
      "panelavo_configure_site_uptime",
      {
        title: "Configure website uptime checks",
        description:
          "Enable or disable Panelavo's HTTPS health check for a writable website and choose a 1-60 minute interval.",
        inputSchema: z
          .object({ domain: domainSchema })
          .extend(uptimeToolSchema.shape),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ domain, enabled, intervalMinutes }, context) => {
        const argumentsValue = { domain, enabled, intervalMinutes };
        const confirmation = await requireSiteActionConfirmation(
          actor,
          confirmationManager,
          {
            context,
            domain,
            tool: "panelavo_configure_site_uptime",
            arguments: argumentsValue,
            message: `Allow the AI assistant to ${enabled ? "enable" : "disable"} uptime checks for ${domain} with a ${intervalMinutes}-minute interval?`,
          },
        );
        if (confirmation) return confirmation;
        return runTool(
          actor,
          "panelavo_configure_site_uptime",
          { type: "site", id: domain },
          { enabled, intervalMinutes },
          () =>
            saveSiteUptimeForActor(actor, domain, {
              enabled,
              intervalMinutes,
            }),
        );
      },
    );

    server.registerTool(
      "panelavo_configure_deploy_hooks",
      {
        title: "Configure after-pull deployment steps",
        description:
          "Replace the ordered, allow-listed Operations that Panelavo runs after a successful Git pull. Send an empty list to remove the plan.",
        inputSchema: z.object({
          domain: domainSchema,
          hooks: z.array(deployHookToolSchema).max(10),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ domain, hooks }, context) => {
        const argumentsValue = { domain, hooks };
        const confirmation = await requireSiteActionConfirmation(
          actor,
          confirmationManager,
          {
            context,
            domain,
            tool: "panelavo_configure_deploy_hooks",
            arguments: argumentsValue,
            message: `Allow the AI assistant to replace the after-pull deployment plan for ${domain} with ${hooks.length} step${hooks.length === 1 ? "" : "s"}?`,
          },
        );
        if (confirmation) return confirmation;
        return runTool(
          actor,
          "panelavo_configure_deploy_hooks",
          { type: "site", id: domain },
          { hookCount: hooks.length },
          () => saveSiteDeployHooksForActor(actor, domain, hooks),
        );
      },
    );

    server.registerTool(
      "panelavo_configure_backup_schedule",
      {
        title: "Configure scheduled backups",
        description:
          "Configure daily or weekly UTC backups and local snapshot retention for a writable website.",
        inputSchema: z.object({
          domain: domainSchema,
          schedule: backupScheduleToolSchema,
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ domain, schedule }, context) => {
        const argumentsValue = { domain, schedule };
        const confirmation = await requireSiteActionConfirmation(
          actor,
          confirmationManager,
          {
            context,
            domain,
            tool: "panelavo_configure_backup_schedule",
            arguments: argumentsValue,
            message: `Allow the AI assistant to ${schedule.enabled ? "enable" : "disable"} the ${schedule.frequency} backup schedule for ${domain}? Retention is ${schedule.retention} local snapshots.`,
          },
        );
        if (confirmation) return confirmation;
        return runTool(
          actor,
          "panelavo_configure_backup_schedule",
          { type: "site", id: domain },
          {
            enabled: schedule.enabled,
            frequency: schedule.frequency,
            retention: schedule.retention,
          },
          () => saveSiteBackupScheduleForActor(actor, domain, schedule),
        );
      },
    );

    server.registerTool(
      "panelavo_configure_offsite_backup",
      {
        title: "Configure off-site backups",
        description:
          "Save, test, or remove a website's encrypted S3-compatible backup destination. Existing credentials can be retained by leaving the secret empty.",
        inputSchema: z.object({
          domain: domainSchema,
          operation: z.discriminatedUnion("action", [
            z.object({
              action: z.literal("save"),
              destination: offsiteDestinationToolSchema,
            }),
            z.object({ action: z.literal("remove") }),
          ]),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ domain, operation }, context) => {
        const argumentsValue = { domain, operation };
        const confirmation = await requireSiteActionConfirmation(
          actor,
          confirmationManager,
          {
            context,
            domain,
            tool: "panelavo_configure_offsite_backup",
            arguments: argumentsValue,
            message:
              operation.action === "remove"
                ? `Remove the encrypted off-site backup connection for ${domain}? Existing remote backup objects are not deleted.`
                : `Save and test the ${operation.destination.bucket} off-site backup destination for ${domain}? Review the endpoint and credential fields before approving.`,
          },
        );
        if (confirmation) return confirmation;
        return runTool(
          actor,
          "panelavo_configure_offsite_backup",
          { type: "site", id: domain },
          { action: operation.action },
          async (): Promise<unknown> => {
            if (operation.action === "remove")
              return removeSiteOffsiteDestinationForActor(actor, domain);
            return saveSiteOffsiteDestinationForActor(
              actor,
              domain,
              operation.destination,
            );
          },
        );
      },
    );

    server.registerTool(
      "panelavo_manage_offsite_backup",
      {
        title: "Manage an off-site backup",
        description:
          "Upload a complete local snapshot, restore a remote snapshot through Panelavo's validated local restore path, or delete one remote copy.",
        inputSchema: z.object({
          domain: domainSchema,
          action: z.enum(["upload", "restore", "delete"]),
          backupId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ domain, action, backupId }, context) => {
        const argumentsValue = { domain, action, backupId };
        const confirmation = await requireSiteActionConfirmation(
          actor,
          confirmationManager,
          {
            context,
            domain,
            tool: "panelavo_manage_offsite_backup",
            arguments: argumentsValue,
            message:
              action === "restore"
                ? `Restore off-site backup ${backupId} over the live files and databases for ${domain}? This is an in-place overlay, not a clean replacement.`
                : action === "delete"
                  ? `Delete off-site backup ${backupId} for ${domain}? Type the backup ID to continue.`
                  : `Upload local snapshot ${backupId} to the off-site destination for ${domain}?`,
            ...(action === "delete" ? { confirmationPhrase: backupId } : {}),
          },
        );
        if (confirmation) return confirmation;
        return runTool(
          actor,
          "panelavo_manage_offsite_backup",
          { type: "site", id: domain },
          { action, backupId },
          () =>
            manageSiteOffsiteBackupForActor(actor, domain, action, backupId),
        );
      },
    );

    server.registerTool(
      "panelavo_manage_site_domains",
      {
        title: "Manage website domains and SSL",
        description:
          "Add or remove a visible domain, set the system-domain block or redirect policy, issue a selected-domain certificate, or ensure SSL for every configured domain. Panelavo keeps vhost, domain metadata, DNS planning, and certificates in sync.",
        inputSchema: z.object({
          domain: domainSchema.describe("The website's system domain."),
          operation: siteDomainOperationToolSchema,
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ domain, operation }, context) => {
        const argumentsValue = { domain, operation };
        const target = "domain" in operation ? operation.domain : domain;
        const confirmation = await requireSiteActionConfirmation(
          actor,
          confirmationManager,
          {
            context,
            domain,
            tool: "panelavo_manage_site_domains",
            arguments: argumentsValue,
            message: `Allow the AI assistant to ${operation.action} for ${domain}? This can change the live vhost, public DNS, or certificate configuration. Review the requested tool arguments before approving.`,
            ...(operation.action === "remove-alias"
              ? { confirmationPhrase: target }
              : {}),
          },
        );
        if (confirmation) return confirmation;
        return runTool(
          actor,
          "panelavo_manage_site_domains",
          { type: "site", id: domain },
          { action: operation.action, target },
          async () =>
            manageSiteDomainsForActor(
              actor,
              domain,
              operation,
              await getServerPublicIp(),
            ),
        );
      },
    );

    server.registerTool(
      "panelavo_point_site_dns",
      {
        title: "Point website DNS",
        description:
          "Create the Cloudflare DNS records needed to point one accessible system domain or visible alias at this Panelavo server. Existing conflicting records are preserved unless replace is explicitly approved.",
        inputSchema: z.object({
          domain: domainSchema,
          credentialId: z.string().min(1).max(128),
          zoneId: z.string().min(1).max(128),
          replace: z.boolean().default(false),
          proxied: z.boolean().default(false),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ domain, credentialId, zoneId, replace, proxied }, context) => {
        const access = await accessibleDomainTargetForActor(actor, domain, {
          write: true,
        });
        const argumentsValue = {
          domain,
          credentialId,
          zoneId,
          replace,
          proxied,
        };
        const confirmation = await requireSiteActionConfirmation(
          actor,
          confirmationManager,
          {
            context,
            domain: access.site.domain,
            tool: "panelavo_point_site_dns",
            arguments: argumentsValue,
            message: replace
              ? `Allow the AI assistant to replace conflicting DNS records for ${domain} and point it to this server? Type the exact domain to continue.`
              : `Allow the AI assistant to create DNS records for ${domain} and point it to this server? Review the requested tool arguments before approving.`,
            ...(replace ? { confirmationPhrase: domain } : {}),
          },
        );
        if (confirmation) return confirmation;
        return runTool(
          actor,
          "panelavo_point_site_dns",
          { type: "domain", id: domain },
          { replace, proxied },
          async () =>
            pointSiteDnsForActor(
              actor,
              domain,
              { credentialId, zoneId, replace, proxied },
              await getServerPublicIp(),
            ),
        );
      },
    );

    server.registerTool(
      "panelavo_create_linked_service",
      {
        title: "Create a linked service",
        description:
          "Create a reverse-proxy service under an accessible parent website. Panelavo allocates the system domain and site user, reserves the selected loopback port, configures aliases, plans DNS, and starts SSL issuance.",
        inputSchema: linkedServiceToolSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ domain, serviceName, targetPort, aliases }, context) => {
        const argumentsValue = {
          domain,
          serviceName,
          targetPort,
          aliases,
        };
        const confirmation = await requireSiteActionConfirmation(
          actor,
          confirmationManager,
          {
            context,
            domain,
            tool: "panelavo_create_linked_service",
            arguments: argumentsValue,
            message: `Allow the AI assistant to create the linked service ${serviceName} under ${domain} on port ${targetPort}? Review the domains and port before approving.`,
          },
        );
        if (confirmation) return confirmation;
        return runTool(
          actor,
          "panelavo_create_linked_service",
          { type: "site", id: domain },
          { serviceName, targetPort, aliasCount: aliases.length },
          async () => {
            rateLimit(`mcp:site-create:${actor.user.id}`, 5, 10 * 60_000);
            const created = await createLinkedServiceForActor(
              actor,
              domain,
              { serviceName, targetPort, aliases },
              { serverIp: await getServerPublicIp() },
            );
            return { site: created.site, warnings: created.warnings };
          },
        );
      },
    );

    server.registerTool(
      "panelavo_update_site",
      {
        title: "Update website settings",
        description:
          "Change the application root, serving directory, runtime, app port, reverse-proxy URL, or friendly label for an accessible website.",
        inputSchema: updateSiteToolSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ domain, ...settings }, context) => {
        const confirmation = await requireSiteActionConfirmation(
          actor,
          confirmationManager,
          {
            context,
            domain,
            tool: "panelavo_update_site",
            arguments: { domain, ...settings },
            message: `Allow the AI assistant to change website settings for ${domain}? Review the requested tool arguments before approving.`,
          },
        );
        if (confirmation) return confirmation;
        return runTool(
          actor,
          "panelavo_update_site",
          { type: "site", id: domain },
          {},
          () =>
            updateManagedSite(actor, domain, updateSiteSchema.parse(settings)),
        );
      },
    );

    server.registerTool(
      "panelavo_manage_site_section",
      {
        title: "Manage a website area",
        description:
          "Run an existing Panelavo website action with the same safety checks as the UI. Supported areas include operations, vhost, databases, certificates, security, access users, files, Git, environment, terminal, backups, cron jobs, and logs. Use the dedicated domain and DNS tools for domain, DNS, and SSL orchestration. Inspect the area first to discover current state and allowed actions.",
        inputSchema: siteSectionToolSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ domain, section, operation }, context) => {
        const action = String(operation.action ?? "");
        const confirmation = await requireSiteActionConfirmation(
          actor,
          confirmationManager,
          {
            context,
            domain,
            tool: "panelavo_manage_site_section",
            arguments: { domain, section, operation },
            message: `Allow the AI assistant to run the ${action || "requested"} action in ${section} for ${domain}? Review the requested tool arguments before approving.`,
          },
        );
        if (confirmation) return confirmation;
        return runTool(
          actor,
          "panelavo_manage_site_section",
          { type: "site", id: domain },
          { section, action },
          () => manageSiteSectionForActor(actor, domain, section, operation),
        );
      },
    );

    server.registerTool(
      "panelavo_create_backup",
      {
        title: "Back up a website",
        description:
          "Create an on-server snapshot of the website files and selected databases before a change.",
        inputSchema: z.object({
          domain: domainSchema,
          files: z.boolean().default(true),
          databases: z.array(z.string().max(64)).max(50).optional(),
          note: z.string().max(200).optional(),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ domain, ...backup }) =>
        runTool(
          actor,
          "panelavo_create_backup",
          { type: "site", id: domain },
          {},
          () =>
            manageSiteSectionForActor(actor, domain, "backups", {
              action: "create",
              ...backup,
            }),
        ),
    );

    server.registerTool(
      "panelavo_deploy_site",
      {
        title: "Deploy a website",
        description:
          "Run one of Panelavo's server-owned deployment plans after inspecting the operations preflight. Use the plan ID shown as ready.",
        inputSchema: z.object({
          domain: domainSchema,
          plan: z.enum(["compose", "node", "static-build", "php", "python"]),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ domain, plan }, context) => {
        const confirmation = await requireSiteActionConfirmation(
          actor,
          confirmationManager,
          {
            context,
            domain,
            tool: "panelavo_deploy_site",
            arguments: { domain, plan },
            message: `Allow the AI assistant to deploy ${domain} with the ${plan} plan? This can restart the live website.`,
          },
        );
        if (confirmation) return confirmation;
        return runTool(
          actor,
          "panelavo_deploy_site",
          { type: "site", id: domain },
          { plan },
          async () => {
            assertReadyOperation(
              await getSiteSectionForActor(actor, domain, "actions"),
              "plan",
              plan,
            );
            return manageSiteSectionForActor(actor, domain, "actions", {
              action: "deploy",
              plan,
            });
          },
        );
      },
    );

    server.registerTool(
      "panelavo_run_site_operation",
      {
        title: "Run a safe website operation",
        description:
          "Run an allow-listed Panelavo operation or repair. Inspect operations first and use only a command or fix currently marked ready. Host repairs remain Super Admin-only.",
        inputSchema: z.object({
          domain: domainSchema,
          command: z.enum(operationCommands).optional(),
          fix: z.enum(operationFixCommands).optional(),
          script: z.string().max(64).optional(),
          name: z.string().max(100).optional(),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ domain, command, fix, script, name }, context) => {
        if (Boolean(command) === Boolean(fix))
          throw new AppError(
            "INVALID_REQUEST",
            "Choose exactly one operation command or repair.",
            400,
          );
        const selected = fix ?? command!;
        const confirmation = await requireSiteActionConfirmation(
          actor,
          confirmationManager,
          {
            context,
            domain,
            tool: "panelavo_run_site_operation",
            arguments: { domain, command, fix, script, name },
            message: `Allow the AI assistant to run ${selected} for ${domain}? This operation can change or restart the live website${fix ? " and may repair host software when your live role permits it" : ""}.`,
          },
        );
        if (confirmation) return confirmation;
        return runTool(
          actor,
          "panelavo_run_site_operation",
          { type: "site", id: domain },
          { command, fix },
          async () => {
            assertReadyOperation(
              await getSiteSectionForActor(actor, domain, "actions"),
              fix ? "fix" : "command",
              selected,
            );
            return manageSiteSectionForActor(
              actor,
              domain,
              "actions",
              fix
                ? { action: "fix", fix }
                : { action: "run", command, script, name },
            );
          },
        );
      },
    );

    server.registerTool(
      "panelavo_execute_terminal_command",
      {
        title: "Run a website terminal command",
        description:
          "Run one bounded, non-interactive command as the unprivileged website system user inside its permitted working directory. This never runs as root.",
        inputSchema: z.object({
          domain: domainSchema,
          command: z.string().min(1).max(4000),
          cwd: z.string().max(512).optional(),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ domain, command, cwd }, context) => {
        const confirmation = await requireSiteActionConfirmation(
          actor,
          confirmationManager,
          {
            context,
            domain,
            tool: "panelavo_execute_terminal_command",
            arguments: { domain, command, cwd },
            message: `Allow the AI assistant to run a terminal command as the unprivileged website user for ${domain}? Review the exact command in the requested tool arguments before approving.`,
          },
        );
        if (confirmation) return confirmation;
        return runTool(
          actor,
          "panelavo_execute_terminal_command",
          { type: "site", id: domain },
          {},
          () =>
            manageSiteSectionForActor(actor, domain, "terminal", {
              action: "exec",
              command,
              cwd,
            }),
        );
      },
    );

    server.registerTool(
      "panelavo_delete_site",
      {
        title: "Delete a website",
        description:
          "Permanently delete a website after checking linked services. Panelavo asks the signed-in user for a separate, exact-domain confirmation before deletion.",
        inputSchema: z.object({
          domain: domainSchema,
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ domain }, context) => {
        const confirmation = await requireSiteActionConfirmation(
          actor,
          confirmationManager,
          {
            context,
            domain,
            tool: "panelavo_delete_site",
            arguments: { action: "delete", domain },
            message: `Permanently delete ${domain}? This removes the website and cannot be undone by Panelavo. Type the exact domain to continue.`,
            confirmationPhrase: domain,
          },
        );
        if (confirmation) return confirmation;
        return runTool(
          actor,
          "panelavo_delete_site",
          { type: "site", id: domain },
          {},
          () => deleteManagedSite(actor, domain),
        );
      },
    );
  }

  if (["manager", "super-admin"].includes(actor.user.panelRole ?? "")) {
    server.registerTool(
      "panelavo_get_server_resources",
      {
        title: "Inspect server resources",
        description:
          "Get the server's current CPU, memory, disk, load, and per-user usage.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () =>
        runTool(
          actor,
          "panelavo_get_server_resources",
          { type: "server" },
          {},
          () => getCloudPanelClient().getServerResources(actor.cloudPanel),
        ),
    );
    server.registerTool(
      "panelavo_get_server_information",
      {
        title: "Inspect server information",
        description:
          "Get the server hostname, operating system, uptime, capacity, and installed software.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () =>
        runTool(
          actor,
          "panelavo_get_server_information",
          { type: "server" },
          {},
          () => getCloudPanelClient().getServerInfo(actor.cloudPanel),
        ),
    );
  }

  return server;
}
