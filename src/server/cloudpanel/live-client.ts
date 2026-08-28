import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import type {
  CloudPanelClient,
  CloudPanelLoginResult,
  CloudPanelSession,
  CloudPanelSite,
  CloudPanelUser,
  CreateSiteInput,
  ServerInfo,
  ServerMaintenanceState,
  ServerResources,
  ServerStorageBreakdown,
  ServerStorageCleanupResult,
  SiteCreationOptions,
  SiteDatastoreOperation,
  SiteEndpointOperation,
  SiteEndpointResult,
  SiteReleaseOperation,
  SiteRecoveryOperation,
  SiteSectionExecutionOptions,
  UpdateProfileInput,
} from "@/types/cloudpanel";
import { isPanelAdmin } from "@/server/auth/panel-roles";
import { getDatabaseManagerUrl } from "@/server/sites/database-manager";
import {
  getSiteRootOverride,
  getSiteRootOverrides,
} from "@/server/sites/site-root-overlay";
import { getSiteTypeOverrides } from "@/server/sites/site-type-overlay";
import { AppError } from "./errors";

export const CLOUDPANEL_BROKER_PROTOCOL_VERSION = 23;
export const CLOUDPANEL_BROKER_PATH =
  "/usr/local/libexec/panelavo/panelavo-broker";

const SITE_SECTION_TIMEOUTS: Readonly<Record<string, number>> = {
  actions: 1_850_000,
  backups: 1_850_000,
  "file-manager": 620_000,
  git: 300_000,
  terminal: 200_000,
  env: 60_000,
};

export function siteSectionTimeout(section: string) {
  return SITE_SECTION_TIMEOUTS[section];
}

type BridgeResult = {
  ok: boolean;
  code?: string | null;
  message?: string | null;
  user?: CloudPanelUser & { mfa?: boolean };
  site?: CloudPanelSite;
  sites?: CloudPanelSite[];
  data?: unknown;
};

export function createdSiteFromBridge(
  result: Pick<BridgeResult, "site">,
  expectedDomain: string,
) {
  const site = result.site;
  if (
    !site ||
    !site.id.trim() ||
    site.domain.toLowerCase() !== expectedDomain.toLowerCase()
  ) {
    throw new AppError(
      "SITE_CREATION_FAILED",
      "The server did not return the created website identity.",
      502,
    );
  }
  return site;
}

let brokerHealth: { checkedAt: number; promise: Promise<void> } | undefined;

function parseBrokerOutput(output: string): BridgeResult {
  try {
    const jsonStart = output.indexOf("{");
    const jsonEnd = output.lastIndexOf("}");
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd >= jsonStart) {
      return JSON.parse(output.slice(jsonStart, jsonEnd + 1)) as BridgeResult;
    }
    return JSON.parse(output.trim()) as BridgeResult;
  } catch {
    throw new AppError(
      "CLOUDPANEL_UNAVAILABLE",
      "The privileged server service returned invalid data.",
      503,
    );
  }
}

function invokeBroker(
  input: Record<string, unknown>,
  timeout = 15_000,
  execution: SiteSectionExecutionOptions = {},
): Promise<BridgeResult> {
  return new Promise((resolve, reject) => {
    if (execution.signal?.aborted) {
      reject(
        new AppError("REQUEST_CANCELLED", "The operation was cancelled.", 409),
      );
      return;
    }
    const child = spawn("/usr/bin/sudo", ["-n", CLOUDPANEL_BROKER_PATH], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stoppedBy: "timeout" | "cancel" | undefined;
    const stop = (reason: "timeout" | "cancel") => {
      if (stoppedBy || child.exitCode !== null || child.signalCode !== null)
        return;
      stoppedBy = reason;
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const abort = () => stop("cancel");
    execution.signal?.addEventListener("abort", abort, { once: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 5_000_000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 500_000) stderr += chunk.toString("utf8");
    });
    child.stdin.end(
      JSON.stringify({
        protocolVersion: CLOUDPANEL_BROKER_PROTOCOL_VERSION,
        ...input,
      }),
    );
    const timer = setTimeout(() => stop("timeout"), timeout);
    child.on("error", () => {
      clearTimeout(timer);
      execution.signal?.removeEventListener("abort", abort);
      reject(
        new AppError(
          "CLOUDPANEL_UNAVAILABLE",
          "The privileged server service could not be started.",
          503,
        ),
      );
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      execution.signal?.removeEventListener("abort", abort);
      if (stoppedBy === "cancel") {
        reject(
          new AppError(
            "REQUEST_CANCELLED",
            "The operation was cancelled.",
            409,
          ),
        );
        return;
      }
      if (stoppedBy === "timeout") {
        reject(
          new AppError(
            "REQUEST_TIMEOUT",
            "The privileged server service took too long to respond.",
            504,
          ),
        );
        return;
      }
      if (code === 0) {
        try {
          resolve(parseBrokerOutput(stdout));
        } catch (error) {
          reject(error);
        }
        return;
      }
      reject(
        new AppError(
          signal === "SIGKILL" ? "REQUEST_TIMEOUT" : "CLOUDPANEL_UNAVAILABLE",
          signal === "SIGKILL"
            ? "The privileged server service took too long to respond."
            : "The privileged server service rejected the request.",
          signal === "SIGKILL" ? 504 : 503,
        ),
      );
    });
  });
}

export async function runScheduledBackup(input: {
  domain: string;
  applicationRootDirectory?: string;
  retention: number;
}): Promise<{ skipped: boolean; backupId?: string }> {
  await checkCloudPanelBroker();
  const result = await invokeBroker(
    { action: "scheduled-backup", ...input },
    1_850_000,
  );
  if (result.code === "OPERATION_BUSY") return { skipped: true };
  if (!result.ok) throw siteSectionBridgeError(result);
  return {
    skipped: false,
    backupId: (result.data as { backupId?: string } | undefined)?.backupId,
  };
}

export async function prepareBackupStaging(): Promise<{ directory: string }> {
  await checkCloudPanelBroker();
  const result = await invokeBroker({ action: "backup-staging" });
  if (!result.ok) throw siteSectionBridgeError(result);
  const data = result.data as { directory?: string } | undefined;
  if (!data?.directory?.match(/^\/run\/user\/\d+\/panelavo-backup-staging$/))
    throw new AppError(
      "CLOUDPANEL_UNAVAILABLE",
      "The backup staging path was invalid.",
      503,
    );
  return { directory: data.directory };
}

export async function stageBackupBundle(input: {
  domain: string;
  id: string;
  applicationRootDirectory?: string;
}): Promise<{ path: string; bytes: number }> {
  await checkCloudPanelBroker();
  const result = await invokeBroker(
    { action: "stage-backup", ...input },
    920_000,
  );
  if (!result.ok) throw siteSectionBridgeError(result);
  const data = result.data as { path?: string; bytes?: number } | undefined;
  if (
    !data?.path?.match(
      /^\/run\/user\/\d+\/panelavo-backup-staging\/[a-f0-9]{32}\.tar\.gz$/,
    )
  )
    throw new AppError(
      "CLOUDPANEL_UNAVAILABLE",
      "The staged backup path was invalid.",
      503,
    );
  return { path: data.path, bytes: Number(data.bytes ?? 0) };
}

export async function importBackupBundle(input: {
  domain: string;
  id: string;
  path: string;
  applicationRootDirectory?: string;
}) {
  await checkCloudPanelBroker();
  const result = await invokeBroker(
    { action: "import-backup-bundle", ...input },
    920_000,
  );
  if (!result.ok) throw siteSectionBridgeError(result);
}

export async function runDatabaseGatewayReconcile() {
  await checkCloudPanelBroker();
  const result = await invokeBroker(
    { action: "database-gateway-reconcile" },
    120_000,
  );
  if (!result.ok) throw siteSectionBridgeError(result);
  return result.data as {
    ready: boolean;
    checkedAt: string;
    repaired: number;
    degraded: number;
  };
}

export async function getDatabaseGatewayCa() {
  await checkCloudPanelBroker();
  const result = await invokeBroker({ action: "database-gateway-ca" });
  if (!result.ok || !result.data)
    throw new AppError(
      "SITE_NOT_FOUND",
      "The database gateway CA certificate is unavailable.",
      404,
    );
  return result.data as {
    certificate: string;
    tlsTrust: "public" | "panelavo-ca";
    suffix: string;
  };
}

export async function runStorageHygiene() {
  await checkCloudPanelBroker();
  const result = await invokeBroker({ action: "storage-hygiene" }, 1_250_000);
  if (!result.ok || !result.data) throw siteSectionBridgeError(result);
  return result.data as {
    checkedAt: string;
    lastCleanupAt?: string;
    mode?: "normal" | "emergency";
    beforePercent?: number;
    afterPercent?: number;
    reclaimedBytes?: number;
    availableBytes: number;
    requiredAvailableBytes: number;
    blocked: boolean;
    reason?: string;
  };
}

export async function getHostMaintenanceStatus() {
  await checkCloudPanelBroker();
  const result = await invokeBroker({ action: "host-maintenance" }, 60_000);
  if (!result.ok || !result.data) throw siteSectionBridgeError(result);
  return result.data as ServerMaintenanceState;
}

export async function checkCloudPanelBroker() {
  const now = Date.now();
  if (!brokerHealth || now - brokerHealth.checkedAt > 60_000) {
    const promise = invokeBroker({ action: "broker-health" }).then((result) => {
      const data = result.data as
        | {
            protocolVersion?: number;
            privileged?: boolean;
            cloudPanelAvailable?: boolean;
            directClpctlDenied?: boolean;
            databaseGatewayReady?: boolean;
          }
        | undefined;
      if (
        !result.ok ||
        data?.protocolVersion !== CLOUDPANEL_BROKER_PROTOCOL_VERSION ||
        data.privileged !== true ||
        data.cloudPanelAvailable !== true ||
        data.directClpctlDenied !== true
      ) {
        throw new AppError(
          "CLOUDPANEL_UNAVAILABLE",
          "The installed server service is unavailable or incompatible.",
          503,
        );
      }
    });
    brokerHealth = { checkedAt: now, promise };
  }
  try {
    await brokerHealth.promise;
  } catch (error) {
    brokerHealth = undefined;
    throw error;
  }
}

export function siteSectionBridgeError(result: BridgeResult) {
  if (result.code === "UPLOAD_TOO_LARGE")
    return new AppError(
      "INVALID_REQUEST",
      "The upload is too large. Files must be 64 MiB or smaller.",
      413,
    );
  if (result.code === "DIRECTORY_NOT_EMPTY")
    return new AppError(
      "INVALID_REQUEST",
      "The website root is not empty. Initialize Git there or remove the existing files before cloning.",
      409,
    );
  if (result.code === "GIT_FAILED") {
    const detail = result.message ?? "";
    const message =
      /permission denied|publickey|authentication failed|could not read username/i.test(
        detail,
      )
        ? "Repository authentication failed. Add this website's public deployment key to the repository and try again."
        : /repository not found|not found|does not exist/i.test(detail)
          ? "The repository or branch was not found. Check the URL, access, and branch name."
          : /host key verification failed/i.test(detail)
            ? "The Git host identity could not be verified. Try the connection again."
            : "Git could not access the repository. Check the URL, deployment key, and branch name.";
    return new AppError("SITE_UPDATE_FAILED", message, 422);
  }
  if (result.code === "OPERATION_BUSY")
    return new AppError(
      "SITE_UPDATE_FAILED",
      "Another operation is already running for this website. Wait for it to finish, then run the preflight again.",
      409,
    );
  if (result.code === "TOOL_UNAVAILABLE")
    return new AppError(
      "SITE_UPDATE_FAILED",
      "A required runtime tool is unavailable. Review the failed preflight check before trying again.",
      409,
    );
  if (result.code === "UNSAFE_COMPOSE")
    return new AppError(
      "INVALID_REQUEST",
      "The Compose configuration does not satisfy Panelavo's host safety policy. Review the preflight blocker and update the project configuration.",
      422,
    );
  if (result.code === "ACTION_UNAVAILABLE")
    return new AppError(
      "INVALID_REQUEST",
      "That action is no longer available for the detected website architecture. Run the preflight again.",
      409,
    );
  if (result.code === "FORBIDDEN")
    return new AppError(
      "FORBIDDEN",
      "This operation requires a Super Admin.",
      403,
    );
  if (result.code === "INVALID_REQUEST" || result.code === "INVALID_ACTION")
    return new AppError(
      "INVALID_REQUEST",
      "The website operation is not valid.",
      400,
    );
  // The bridge often computes a precise, operator-facing reason (e.g. a failed
  // tar/db export, a missing app root) and returns it as SITE_UPDATE_FAILED.
  // Surface that detail instead of collapsing every failure to a generic 502.
  const detail = result.message?.trim();
  return new AppError(
    "SITE_UPDATE_FAILED",
    detail || "The server could not apply the change.",
    502,
  );
}

export class LiveCloudPanelClient implements CloudPanelClient {
  private async bridge(
    input: Record<string, unknown>,
    timeout?: number,
    execution?: SiteSectionExecutionOptions,
  ): Promise<BridgeResult> {
    await checkCloudPanelBroker();
    return invokeBroker(input, timeout, execution);
  }

  private privilegedError(result: BridgeResult, fallback: string) {
    if (result.code === "REQUEST_TIMEOUT")
      return new AppError(
        "REQUEST_TIMEOUT",
        "The server took too long to respond.",
        504,
      );
    const detail = result.message ?? "";
    const message = /already exists|duplicate|already in use/i.test(detail)
      ? "That name is already in use."
      : /database(Name|UserName)|constraint|not valid|validation/i.test(detail)
        ? "Use 2–50 characters, starting with a letter and containing only letters, numbers, and hyphens."
        : fallback;
    return new AppError("CLOUDPANEL_UNAVAILABLE", message, 422);
  }

  private sessionUser(session: CloudPanelSession) {
    if (!session.cliAuthenticated || !session.usernameHint)
      throw new AppError("SESSION_EXPIRED", "Your session has expired.", 401);
    return session.usernameHint;
  }

  // Site-write access: CloudPanel admins and site managers everywhere; panel
  // admins (overlay) only on sites assigned to them (which includes every site
  // they created, because creation auto-assigns).
  private async requireSiteAccess(session: CloudPanelSession, domain?: string) {
    const user = await this.getCurrentUser(session);
    if (user.canCreateSites) return { user, panelAdmin: false };
    if (!(await isPanelAdmin(user.username)))
      throw new AppError(
        "FORBIDDEN",
        "You do not have permission to modify websites.",
        403,
      );
    if (domain !== undefined) {
      const sites = await this.listSites(session);
      if (!sites.some((site) => site.domain === domain))
        throw new AppError("SITE_NOT_FOUND", "Website not found.", 404);
    }
    return { user, panelAdmin: true };
  }

  async login(input: {
    username: string;
    password: string;
  }): Promise<CloudPanelLoginResult> {
    const result = await this.bridge({ action: "login", ...input });
    if (!result.ok || !result.user)
      throw new AppError(
        "INVALID_CREDENTIALS",
        "The user name or password is incorrect.",
        401,
      );
    const session: CloudPanelSession = {
      cookies: {},
      usernameHint: result.user.username,
      cliAuthenticated: true,
    };
    if (result.user.mfa)
      return {
        status: "two-factor-required",
        session: { ...session, pendingTwoFactor: true },
      };
    return { status: "authenticated", session, user: result.user };
  }

  async verifyTwoFactor(input: {
    session: CloudPanelSession;
    code: string;
  }): Promise<CloudPanelLoginResult> {
    const username = this.sessionUser(input.session);
    const result = await this.bridge({
      action: "mfa",
      username,
      code: input.code,
    });
    if (!result.ok || !result.user)
      throw new AppError(
        "INVALID_TWO_FACTOR_CODE",
        "That verification code is not valid.",
        401,
      );
    return {
      status: "authenticated",
      session: { ...input.session, pendingTwoFactor: false },
      user: result.user,
    };
  }

  async getCurrentUser(session: CloudPanelSession) {
    const result = await this.bridge({
      action: "user",
      username: this.sessionUser(session),
    });
    if (!result.ok || !result.user)
      throw new AppError(
        "SESSION_EXPIRED",
        "Your server account is no longer active.",
        401,
      );
    return result.user;
  }

  async listSites(session: CloudPanelSession) {
    const result = await this.bridge({
      action: "sites",
      username: this.sessionUser(session),
    });
    if (!result.ok || !result.sites)
      throw new AppError(
        "CLOUDPANEL_UNAVAILABLE",
        "The server could not list websites.",
        503,
      );
    return result.sites;
  }

  async listUsers(session: CloudPanelSession) {
    const result = await this.bridge({
      action: "users",
      username: this.sessionUser(session),
    });
    if (!result.ok || !result.data || typeof result.data !== "object")
      throw new AppError(
        "FORBIDDEN",
        "Users are available to administrators only.",
        403,
      );
    return (result.data as { users?: CloudPanelUser[] }).users ?? [];
  }

  async manageUser(session: CloudPanelSession, input: Record<string, unknown>) {
    const current = await this.getCurrentUser(session);
    if (current.role !== "admin")
      throw new AppError(
        "FORBIDDEN",
        "Users are available to administrators only.",
        403,
      );
    const action = String(input.action ?? "");
    if (action === "add") {
      let sites = String(input.sites ?? "");
      // clpctl refuses `--role=user --sites=` (a restricted user must be
      // created with at least one site), but panel admins legitimately start
      // with none — they create their own. Borrow an existing site for the
      // add call, then clear the assignment through the bridge.
      const placeholder = String(input.role) === "user" && sites === "";
      if (placeholder) {
        const all = await this.listSites(session);
        if (!all.length)
          throw new AppError(
            "INVALID_REQUEST",
            "Create at least one website before adding restricted users.",
            400,
          );
        sites = all[0].domain;
      }
      const timezone = /^[A-Za-z0-9_+\-/]{1,64}$/.test(
        String(input.timezone ?? ""),
      )
        ? String(input.timezone)
        : "UTC";
      const created = await this.bridge(
        {
          action: "clpctl-user-add",
          username: this.sessionUser(session),
          targetUsername: String(input.username ?? ""),
          email: String(input.email ?? ""),
          firstName: String(input.firstName ?? ""),
          lastName: String(input.lastName ?? ""),
          password: String(input.password ?? ""),
          role: String(input.role ?? ""),
          sites: sites
            .split(",")
            .map((site) => site.trim())
            .filter(Boolean),
          timezone,
        },
        90_000,
      );
      if (!created.ok)
        throw this.privilegedError(
          created,
          "The server could not create the user.",
        );
      if (placeholder) {
        const cleared = await this.bridge({
          action: "manage-user",
          username: this.sessionUser(session),
          operation: {
            username: input.username,
            role: "user",
            status: true,
            sites: [],
          },
        });
        if (!cleared.ok)
          throw new AppError(
            "INVALID_REQUEST",
            "User was created but the placeholder site could not be removed.",
            400,
          );
      }
    } else if (action === "update") {
      const result = await this.bridge({
        action: "manage-user",
        username: this.sessionUser(session),
        operation: input,
      });
      if (!result.ok)
        throw new AppError(
          "INVALID_REQUEST",
          "User settings could not be updated.",
          400,
        );
    } else if (action === "reset-password") {
      const reset = await this.bridge({
        action: "clpctl-user-reset-password",
        username: this.sessionUser(session),
        targetUsername: String(input.username ?? ""),
        password: String(input.password ?? ""),
      });
      if (!reset.ok)
        throw this.privilegedError(
          reset,
          "The server could not reset the password.",
        );
    } else if (action === "delete") {
      const deleted = await this.bridge({
        action: "clpctl-user-delete",
        username: this.sessionUser(session),
        targetUsername: String(input.username ?? ""),
      });
      if (!deleted.ok)
        throw this.privilegedError(
          deleted,
          "The server could not delete the user.",
        );
    } else throw new AppError("INVALID_REQUEST", "Unknown user action.", 400);
  }

  async getSiteCreationOptions(
    session: CloudPanelSession,
  ): Promise<SiteCreationOptions> {
    const user = await this.getCurrentUser(session);
    if (!user.canCreateSites && !(await isPanelAdmin(user.username)))
      throw new AppError(
        "FORBIDDEN",
        "You do not have permission to create websites.",
        403,
      );
    let phpVersions: string[] = [];
    try {
      phpVersions = (await readdir("/etc/php"))
        .filter((v) => /^\d+\.\d+$/.test(v))
        .sort()
        .reverse();
    } catch {}
    const templates = await this.bridge({
      action: "clpctl-vhost-templates",
      username: this.sessionUser(session),
    });
    if (!templates.ok)
      throw this.privilegedError(
        templates,
        "The server could not list vhost templates.",
      );
    const vhostTemplates = Array.isArray(
      (templates.data as { templates?: unknown } | undefined)?.templates,
    )
      ? (templates.data as { templates: unknown[] }).templates.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const reservedPorts = Array.isArray(
      (templates.data as { reservedPorts?: unknown } | undefined)
        ?.reservedPorts,
    )
      ? (templates.data as { reservedPorts: unknown[] }).reservedPorts.filter(
          (value): value is number =>
            Number.isInteger(value) &&
            Number(value) >= 1 &&
            Number(value) <= 65535,
        )
      : [];
    return {
      allowedTypes: [
        "php",
        "nodejs",
        "static",
        "python",
        "reverse-proxy",
        "docker",
      ],
      phpVersions,
      nodeVersions: ["22", "20", "18", "16", "14", "12"],
      pythonVersions: ["3.12", "3.10", "3.9"],
      vhostTemplates,
      reservedPorts,
    };
  }

  async createSite(
    session: CloudPanelSession,
    input: CreateSiteInput,
  ): Promise<CloudPanelSite> {
    const options = await this.getSiteCreationOptions(session);
    if (!options.allowedTypes.includes(input.type))
      throw new AppError(
        "INVALID_SITE_TYPE",
        "This site type is not supported.",
        400,
      );
    if (input.type === "php" && !options.phpVersions.includes(input.phpVersion))
      throw new AppError(
        "INVALID_RUNTIME_VERSION",
        "That PHP version is not installed.",
        400,
      );
    if (
      input.type === "nodejs" &&
      !options.nodeVersions.includes(input.nodeVersion)
    )
      throw new AppError(
        "INVALID_RUNTIME_VERSION",
        "That Node.js version is not supported.",
        400,
      );
    if (
      input.type === "python" &&
      !options.pythonVersions.includes(input.pythonVersion)
    )
      throw new AppError(
        "INVALID_RUNTIME_VERSION",
        "That Python version is not supported.",
        400,
      );
    try {
      const result = await this.bridge(
        {
          action: "clpctl-site-create",
          username: this.sessionUser(session),
          panelAdmin: await isPanelAdmin(this.sessionUser(session)),
          site: input,
        },
        90_000,
      );
      if (!result.ok)
        throw this.privilegedError(
          result,
          "The server could not create the website.",
        );
      return createdSiteFromBridge(result, input.domain);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "SITE_CREATION_FAILED",
        "The server could not create the website.",
        502,
      );
    }
  }

  async updateSite(
    session: CloudPanelSession,
    domain: string,
    input: {
      applicationRootDirectory?: string;
      rootDirectory?: string;
      runtimeVersion?: string;
      appPort?: number;
      reverseProxyUrl?: string;
      endpointParentDomain?: string;
    },
  ) {
    const { panelAdmin } = await this.requireSiteAccess(session, domain);
    const { applicationRootDirectory, endpointParentDomain, ...settings } =
      input;
    const result = await this.bridge({
      action: "update-site",
      username: this.sessionUser(session),
      domain,
      applicationRootDirectory,
      endpointParentDomain,
      settings,
      panelAdmin,
    });
    if (!result.ok)
      throw this.privilegedError(result, "The server could not update the website.");
    if (!result.site)
      throw new AppError(
        "SITE_UPDATE_FAILED",
        "The server could not update the website.",
        502,
      );
    return result.site;
  }

  async deleteSite(session: CloudPanelSession, domain: string) {
    const { panelAdmin } = await this.requireSiteAccess(session, domain);
    const result = await this.bridge(
      {
        action: "clpctl-site-delete",
        username: this.sessionUser(session),
        domain,
        panelAdmin,
      },
      1_850_000,
    );
    if (!result.ok)
      throw this.privilegedError(
        result,
        "The server could not delete the website.",
      );
  }

  async assignSite(session: CloudPanelSession, domain: string) {
    const result = await this.bridge({
      action: "assign-site",
      username: this.sessionUser(session),
      domain,
    });
    if (!result.ok)
      throw new AppError(
        "SITE_UPDATE_FAILED",
        "The website could not be assigned to your account.",
        502,
      );
  }

  async getSiteSection(
    session: CloudPanelSession,
    domain: string,
    section: string,
  ) {
    const applicationRootDirectory = await getSiteRootOverride(domain);
    const result = await this.bridge({
      action: "site-section",
      username: this.sessionUser(session),
      domain,
      section,
      applicationRootDirectory,
    });
    if (!result.ok)
      throw new AppError(
        "SITE_NOT_FOUND",
        "Website section could not be loaded.",
        404,
      );
    return result.data;
  }

  async manageSiteSection(
    session: CloudPanelSession,
    domain: string,
    section: string,
    input: Record<string, unknown>,
    execution?: SiteSectionExecutionOptions,
  ) {
    const { panelAdmin } = await this.requireSiteAccess(session, domain);
    const applicationRootDirectory = await getSiteRootOverride(domain);
    const action = String(input.action ?? "");
    if (panelAdmin && section === "databases" && action === "delete") {
      // clpctl db:delete is addressed by database name alone, so confirm the
      // database actually belongs to this (already authorized) site first.
      const data = (await this.getSiteSection(
        session,
        domain,
        "databases",
      )) as {
        items?: { name?: string }[];
      };
      if (!data?.items?.some((item) => item.name === String(input.name)))
        throw new AppError(
          "FORBIDDEN",
          "That database does not belong to this website.",
          403,
        );
    }
    if (section === "databases" && action.startsWith("exposure-")) {
      const result = await this.bridge(
        {
          action: "database-gateway",
          username: this.sessionUser(session),
          domain,
          panelAdmin,
          operation: input,
        },
        90_000,
      );
      if (!result.ok)
        throw siteSectionBridgeError(result);
      return result.data;
    } else if (section === "databases" && action === "add") {
      const result = await this.bridge(
        {
          action: "clpctl-db-add",
          username: this.sessionUser(session),
          domain,
          panelAdmin,
          databaseName: String(input.name ?? ""),
          databaseUsername: String(input.username ?? ""),
          password: String(input.password ?? ""),
        },
        90_000,
      );
      if (!result.ok)
        throw this.privilegedError(
          result,
          "The server could not create the database.",
        );
    } else if (section === "databases" && action === "delete") {
      const result = await this.bridge(
        {
          action: "clpctl-db-delete",
          username: this.sessionUser(session),
          domain,
          panelAdmin,
          databaseName: String(input.name ?? ""),
        },
        90_000,
      );
      if (!result.ok)
        throw this.privilegedError(
          result,
          "The server could not delete the database.",
        );
    } else if (section === "databases" && action === "manage-login") {
      // One-time phpMyAdmin sign-on: the broker writes the database user's
      // credentials into an expiring token file readable only by the
      // database-manager site; the browser receives just the random token.
      const managerUrl = await getDatabaseManagerUrl();
      if (!managerUrl)
        throw new AppError(
          "INVALID_REQUEST",
          "No database manager is configured on this server.",
          400,
        );
      const result = await this.bridge(
        {
          action: "db-signon",
          username: this.sessionUser(session),
          domain,
          panelAdmin,
          databaseName: String(input.name ?? ""),
          managerDomain: new URL(managerUrl).hostname,
        },
        30_000,
      );
      if (!result.ok)
        throw this.privilegedError(
          result,
          "The phpMyAdmin sign-in could not be prepared.",
        );
      const signon = result.data as { token?: string; db?: string };
      if (!signon?.token)
        throw new AppError(
          "SITE_UPDATE_FAILED",
          "The phpMyAdmin sign-in could not be prepared.",
          502,
        );
      return {
        url: `${managerUrl}/signon.php?token=${encodeURIComponent(signon.token)}`,
      };
    } else if (section === "certificates" && action === "lets-encrypt") {
      const result = await this.bridge(
        {
          action: "clpctl-cert-install",
          username: this.sessionUser(session),
          domain,
          panelAdmin,
          subjectAlternativeNames: input.subjectAlternativeName
            ? String(input.subjectAlternativeName)
                .split(",")
                .map((name) => name.trim())
                .filter(Boolean)
            : [],
        },
        90_000,
      );
      if (!result.ok)
        throw this.privilegedError(
          result,
          "The server could not install the certificate.",
        );
    } else {
      // Site actions (npm install, builds, docker compose…) legitimately run
      // for minutes; everything else stays on the short default timeout.
      const result = await this.bridge(
        {
          action: "manage-section",
          username: this.sessionUser(session),
          domain,
          section,
          operation: input,
          panelAdmin,
          applicationRootDirectory,
        },
        section === "git" &&
          Array.isArray(input.deployOperations) &&
          input.deployOperations.length > 0
          ? SITE_SECTION_TIMEOUTS.actions
          : siteSectionTimeout(section),
        execution,
      );
      if (!result.ok) throw siteSectionBridgeError(result);
      if (result.data !== undefined) return result.data;
    }
    return this.getSiteSection(session, domain, section);
  }

  async manageSiteRelease(
    session: CloudPanelSession,
    domain: string,
    operation: SiteReleaseOperation,
    execution?: SiteSectionExecutionOptions,
  ) {
    const { panelAdmin } = await this.requireSiteAccess(session, domain);
    const applicationRootDirectory = await getSiteRootOverride(domain);
    const result = await this.bridge(
      {
        action: "site-release",
        username: this.sessionUser(session),
        domain,
        panelAdmin,
        applicationRootDirectory,
        operation,
      },
      SITE_SECTION_TIMEOUTS.actions,
      execution,
    );
    if (!result.ok) throw siteSectionBridgeError(result);
    return result.data;
  }

  async manageSiteRecovery(
    session: CloudPanelSession,
    domain: string,
    operation: SiteRecoveryOperation,
    execution?: SiteSectionExecutionOptions,
  ) {
    const { panelAdmin } = await this.requireSiteAccess(session, domain);
    const applicationRootDirectory = await getSiteRootOverride(domain);
    const result = await this.bridge(
      {
        action: "site-recovery",
        username: this.sessionUser(session),
        domain,
        panelAdmin,
        applicationRootDirectory,
        operation,
      },
      SITE_SECTION_TIMEOUTS.actions,
      execution,
    );
    if (!result.ok) throw siteSectionBridgeError(result);
    return result.data;
  }

  async manageSiteDatastore(
    session: CloudPanelSession,
    domain: string,
    operation: SiteDatastoreOperation,
    execution?: SiteSectionExecutionOptions,
  ) {
    const { panelAdmin } = await this.requireSiteAccess(session, domain);
    const applicationRootDirectory = await getSiteRootOverride(domain);
    const result = await this.bridge(
      {
        action: "site-datastore",
        username: this.sessionUser(session),
        domain,
        panelAdmin,
        applicationRootDirectory,
        operation,
      },
      SITE_SECTION_TIMEOUTS.actions,
      execution,
    );
    if (!result.ok) throw siteSectionBridgeError(result);
    return result.data;
  }

  async manageSiteEndpoint(
    session: CloudPanelSession,
    domain: string,
    operation: SiteEndpointOperation,
  ): Promise<SiteEndpointResult> {
    const { panelAdmin } = await this.requireSiteAccess(session, domain);
    const result = await this.bridge({
      action: "site-endpoint",
      username: this.sessionUser(session),
      domain,
      operation,
      panelAdmin,
    });
    if (!result.ok || !result.data)
      throw this.privilegedError(
        result,
        "The project endpoint could not be inspected.",
      );
    return result.data as SiteEndpointResult;
  }

  async getServerResources(session: CloudPanelSession) {
    const [siteRoots, siteTypes] = await Promise.all([
      getSiteRootOverrides(),
      getSiteTypeOverrides(),
    ]);
    const result = await this.bridge(
      {
        action: "server-resources",
        username: this.sessionUser(session),
        siteRoots,
        siteTypes,
      },
      60_000,
    );
    if (!result.ok || !result.data)
      throw new AppError(
        "FORBIDDEN",
        "Server resources are available to administrators only.",
        403,
      );
    return result.data as ServerResources;
  }

  async getServerStorage(session: CloudPanelSession, refresh = false) {
    const [siteRoots, siteTypes] = await Promise.all([
      getSiteRootOverrides(),
      getSiteTypeOverrides(),
    ]);
    const result = await this.bridge(
      {
        action: "server-storage",
        username: this.sessionUser(session),
        siteRoots,
        siteTypes,
        refresh,
      },
      310_000,
    );
    if (!result.ok || !result.data)
      throw new AppError(
        "CLOUDPANEL_UNAVAILABLE",
        "The server storage analysis could not be completed.",
        503,
      );
    return result.data as ServerStorageBreakdown;
  }

  async reclaimServerStorage(session: CloudPanelSession) {
    const [siteRoots, siteTypes] = await Promise.all([
      getSiteRootOverrides(),
      getSiteTypeOverrides(),
    ]);
    const result = await this.bridge(
      {
        action: "server-storage-reclaim",
        username: this.sessionUser(session),
        siteRoots,
        siteTypes,
      },
      1_810_000,
    );
    if (!result.ok || !result.data)
      throw new AppError(
        "CLOUDPANEL_UNAVAILABLE",
        "Safe build-cache cleanup could not be completed.",
        503,
      );
    return result.data as ServerStorageCleanupResult;
  }

  async getServerInfo(session: CloudPanelSession) {
    const result = await this.bridge(
      {
        action: "server-info",
        username: this.sessionUser(session),
      },
      60_000,
    );
    if (!result.ok || !result.data)
      throw new AppError(
        "FORBIDDEN",
        "Server information is available to administrators only.",
        403,
      );
    return result.data as ServerInfo;
  }

  async updateProfile(session: CloudPanelSession, input: UpdateProfileInput) {
    const username = this.sessionUser(session);
    if (input.action === "change-password") {
      // Verify the current password before resetting; clpctl itself has no
      // notion of "change with verification".
      const check = await this.bridge({
        action: "login",
        username,
        password: input.currentPassword,
      });
      if (!check.ok)
        throw new AppError(
          "INVALID_CREDENTIALS",
          "Your current password is incorrect.",
          401,
        );
      const reset = await this.bridge({
        action: "clpctl-user-reset-password",
        username,
        targetUsername: username,
        password: input.newPassword,
        selfService: true,
      });
      if (!reset.ok)
        throw this.privilegedError(
          reset,
          "The server could not change your password.",
        );
      return this.getCurrentUser(session);
    }
    const result = await this.bridge({
      action: "update-profile",
      username,
      profile: {
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        timezone: input.timezone,
      },
    });
    if (!result.ok || !result.user)
      throw new AppError(
        "INVALID_REQUEST",
        "Your profile could not be updated.",
        400,
      );
    return result.user;
  }

  async verifyPassword(session: CloudPanelSession, password: string) {
    const result = await this.bridge({
      action: "login",
      username: this.sessionUser(session),
      password,
    });
    if (!result.ok)
      throw new AppError(
        "INVALID_CREDENTIALS",
        "Your current password is incorrect.",
        401,
      );
  }

  async manageMfa(
    session: CloudPanelSession,
    input: { action: "enable" | "disable"; secret?: string; code: string },
  ) {
    const result = await this.bridge({
      action: "manage-mfa",
      username: this.sessionUser(session),
      operation: input,
    });
    if (!result.ok || !result.user)
      throw new AppError(
        result.code === "INVALID_TWO_FACTOR_CODE"
          ? "INVALID_TWO_FACTOR_CODE"
          : "INVALID_REQUEST",
        result.code === "INVALID_TWO_FACTOR_CODE"
          ? "That verification code is not valid."
          : result.message || "Two-factor authentication could not be changed.",
        result.code === "INVALID_TWO_FACTOR_CODE" ? 401 : 400,
      );
    return result.user;
  }

  async logout() {}
}
