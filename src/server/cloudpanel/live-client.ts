import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  CloudPanelClient,
  CloudPanelLoginResult,
  CloudPanelSession,
  CloudPanelSite,
  CloudPanelUser,
  CreateSiteInput,
  ServerInfo,
  ServerResources,
  SiteCreationOptions,
  UpdateProfileInput,
} from "@/types/cloudpanel";
import { isPanelAdmin } from "@/server/auth/panel-roles";
import { AppError } from "./errors";

type BridgeResult = {
  ok: boolean;
  code?: string | null;
  message?: string | null;
  user?: CloudPanelUser & { mfa?: boolean };
  site?: CloudPanelSite;
  sites?: CloudPanelSite[];
  data?: unknown;
};

export function siteSectionBridgeError(result: BridgeResult) {
  if (result.code === "UPLOAD_TOO_LARGE")
    return new AppError("INVALID_REQUEST", "The upload is too large. Files must be 64 MiB or smaller.", 413);
  if (result.code === "DIRECTORY_NOT_EMPTY")
    return new AppError("INVALID_REQUEST", "The website root is not empty. Initialize Git there or remove the existing files before cloning.", 409);
  if (result.code === "GIT_FAILED") {
    const detail = result.message ?? "";
    const message = /permission denied|publickey|authentication failed|could not read username/i.test(detail)
      ? "Repository authentication failed. Add this website's public deployment key to the repository and try again."
      : /repository not found|not found|does not exist/i.test(detail)
        ? "The repository or branch was not found. Check the URL, access, and branch name."
        : /host key verification failed/i.test(detail)
          ? "The Git host identity could not be verified. Try the connection again."
          : "Git could not access the repository. Check the URL, deployment key, and branch name.";
    return new AppError("SITE_UPDATE_FAILED", message, 422);
  }
  if (result.code === "OPERATION_BUSY")
    return new AppError("SITE_UPDATE_FAILED", "Another operation is already running for this website. Wait for it to finish, then run the preflight again.", 409);
  if (result.code === "TOOL_UNAVAILABLE")
    return new AppError("SITE_UPDATE_FAILED", "A required runtime tool is unavailable. Review the failed preflight check before trying again.", 409);
  if (result.code === "UNSAFE_COMPOSE")
    return new AppError("INVALID_REQUEST", "The Compose configuration does not satisfy Panelavo's host safety policy. Review the preflight blocker and update the project configuration.", 422);
  if (result.code === "ACTION_UNAVAILABLE")
    return new AppError("INVALID_REQUEST", "That action is no longer available for the detected website architecture. Run the preflight again.", 409);
  if (result.code === "INVALID_REQUEST" || result.code === "INVALID_ACTION")
    return new AppError("INVALID_REQUEST", "The website operation is not valid.", 400);
  return new AppError("SITE_UPDATE_FAILED", "CloudPanel could not apply the change.", 502);
}

export class LiveCloudPanelClient implements CloudPanelClient {
  private run(
    executable: string,
    args: string[],
    options: { input?: string; timeout?: number } = {},
  ) {
    return new Promise<string>((resolve, reject) => {
      const child = spawn("/usr/bin/sudo", ["-n", executable, ...args], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const collectStdout = (chunk: Buffer) => {
        if (stdout.length < 5_000_000) stdout += chunk.toString("utf8");
      };
      const collectStderr = (chunk: Buffer) => {
        if (stderr.length < 500_000) stderr += chunk.toString("utf8");
      };
      child.stdout.on("data", collectStdout);
      child.stderr.on("data", collectStderr);
      if (options.input) child.stdin.end(options.input);
      else child.stdin.end();
      const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeout ?? 15_000);
      child.on("error", () => {
        clearTimeout(timeout);
        reject(new AppError("CLOUDPANEL_UNAVAILABLE", "CloudPanel CLI could not be started.", 503));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        if (code === 0) resolve(stdout);
        else {
          const cliOutput = `${stdout}\n${stderr}`;
          const message = signal === "SIGKILL" ? "CloudPanel CLI took too long to respond."
            : /already exists|duplicate|already in use/i.test(cliOutput) ? "That name is already in use."
            : /database(Name|UserName)|constraint|not valid|validation/i.test(cliOutput) ? "Use 2–50 characters, starting with a letter and containing only letters, numbers, and hyphens."
            : "CloudPanel could not complete the operation. Check the submitted values and try again.";
          reject(new AppError(signal === "SIGKILL" ? "REQUEST_TIMEOUT" : "CLOUDPANEL_UNAVAILABLE", message, signal === "SIGKILL" ? 504 : 422));
        }
      });
    });
  }

  private async bridge(
    input: Record<string, unknown>,
    timeout?: number,
  ): Promise<BridgeResult> {
    const script = join(process.cwd(), "scripts", "cloudpanel-bridge.php");
    const output = await this.run("/usr/bin/php", [script], {
      input: JSON.stringify(input),
      timeout,
    });
    try {
      const jsonStart = output.indexOf('{');
      const jsonEnd = output.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd >= jsonStart) {
        return JSON.parse(output.slice(jsonStart, jsonEnd + 1)) as BridgeResult;
      }
      return JSON.parse(output.trim()) as BridgeResult;
    } catch {
      throw new AppError("CLOUDPANEL_UNAVAILABLE", "CloudPanel CLI returned invalid data.", 503);
    }
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
      throw new AppError("FORBIDDEN", "You do not have permission to modify websites.", 403);
    if (domain !== undefined) {
      const sites = await this.listSites(session);
      if (!sites.some((site) => site.domain === domain))
        throw new AppError("SITE_NOT_FOUND", "Website not found.", 404);
    }
    return { user, panelAdmin: true };
  }

  async login(input: { username: string; password: string }): Promise<CloudPanelLoginResult> {
    const result = await this.bridge({ action: "login", ...input });
    if (!result.ok || !result.user)
      throw new AppError("INVALID_CREDENTIALS", "The user name or password is incorrect.", 401);
    const session: CloudPanelSession = {
      cookies: {},
      usernameHint: result.user.username,
      cliAuthenticated: true,
    };
    if (result.user.mfa)
      return { status: "two-factor-required", session: { ...session, pendingTwoFactor: true } };
    return { status: "authenticated", session, user: result.user };
  }

  async verifyTwoFactor(input: { session: CloudPanelSession; code: string }): Promise<CloudPanelLoginResult> {
    const username = this.sessionUser(input.session);
    const result = await this.bridge({ action: "mfa", username, code: input.code });
    if (!result.ok || !result.user)
      throw new AppError("INVALID_TWO_FACTOR_CODE", "That verification code is not valid.", 401);
    return {
      status: "authenticated",
      session: { ...input.session, pendingTwoFactor: false },
      user: result.user,
    };
  }

  async getCurrentUser(session: CloudPanelSession) {
    const result = await this.bridge({ action: "user", username: this.sessionUser(session) });
    if (!result.ok || !result.user)
      throw new AppError("SESSION_EXPIRED", "Your CloudPanel account is no longer active.", 401);
    return result.user;
  }

  async listSites(session: CloudPanelSession) {
    const result = await this.bridge({ action: "sites", username: this.sessionUser(session) });
    if (!result.ok || !result.sites)
      throw new AppError("CLOUDPANEL_UNAVAILABLE", "CloudPanel could not list websites.", 503);
    return result.sites;
  }

  async listUsers(session: CloudPanelSession) {
    const result = await this.bridge({ action: "users", username: this.sessionUser(session) });
    if (!result.ok || !result.data || typeof result.data !== "object") throw new AppError("FORBIDDEN", "Users are available to administrators only.", 403);
    return ((result.data as { users?: CloudPanelUser[] }).users ?? []);
  }

  async manageUser(session: CloudPanelSession, input: Record<string, unknown>) {
    const current = await this.getCurrentUser(session); if (current.role !== "admin") throw new AppError("FORBIDDEN", "Users are available to administrators only.", 403);
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
          throw new AppError("INVALID_REQUEST", "Create at least one website before adding restricted users.", 400);
        sites = all[0].domain;
      }
      const timezone = /^[A-Za-z0-9_+\-/]{1,64}$/.test(String(input.timezone ?? "")) ? String(input.timezone) : "UTC";
      await this.run("/usr/bin/clpctl", ["user:add", `--userName=${String(input.username)}`, `--email=${String(input.email)}`, `--firstName=${String(input.firstName)}`, `--lastName=${String(input.lastName)}`, `--password=${String(input.password)}`, `--role=${String(input.role)}`, `--sites=${sites}`, `--timezone=${timezone}`, "--status=1"], { timeout: 90_000 });
      if (placeholder) {
        const cleared = await this.bridge({ action: "manage-user", username: this.sessionUser(session), operation: { username: input.username, role: "user", status: true, sites: [] } });
        if (!cleared.ok) throw new AppError("INVALID_REQUEST", "User was created but the placeholder site could not be removed.", 400);
      }
    }
    else if (action === "update") { const result = await this.bridge({ action: "manage-user", username: this.sessionUser(session), operation: input }); if (!result.ok) throw new AppError("INVALID_REQUEST", "User settings could not be updated.", 400); }
    else if (action === "reset-password") await this.run("/usr/bin/clpctl", ["user:reset:password", `--userName=${String(input.username)}`, `--password=${String(input.password)}`]);
    else if (action === "delete") await this.run("/usr/bin/clpctl", ["user:delete", `--userName=${String(input.username)}`, "--force"]);
    else throw new AppError("INVALID_REQUEST", "Unknown user action.", 400);
  }

  async getSiteCreationOptions(session: CloudPanelSession): Promise<SiteCreationOptions> {
    const user = await this.getCurrentUser(session);
    if (!user.canCreateSites && !(await isPanelAdmin(user.username)))
      throw new AppError("FORBIDDEN", "You do not have permission to create websites.", 403);
    let phpVersions: string[] = [];
    try {
      phpVersions = (await readdir("/etc/php")).filter((v) => /^\d+\.\d+$/.test(v)).sort().reverse();
    } catch {}
    const templates = await this.run("/usr/bin/clpctl", ["vhost-templates:list"]);
    const vhostTemplates = templates.split("\n")
      .filter((line) => /^\|/.test(line) && !/Name\s+\|/.test(line))
      .map((line) => line.split("|")[1]?.trim())
      .filter((value): value is string => Boolean(value));
    return {
      allowedTypes: ["php", "nodejs", "static", "python", "reverse-proxy", "docker"],
      phpVersions,
      nodeVersions: ["22", "20", "18", "16", "14", "12"],
      pythonVersions: ["3.12", "3.10", "3.9"],
      vhostTemplates,
    };
  }

  async createSite(session: CloudPanelSession, input: CreateSiteInput): Promise<CloudPanelSite> {
    const options = await this.getSiteCreationOptions(session);
    if (!options.allowedTypes.includes(input.type))
      throw new AppError("INVALID_SITE_TYPE", "This site type is not supported.", 400);
    if (input.type === "php" && !options.phpVersions.includes(input.phpVersion))
      throw new AppError("INVALID_RUNTIME_VERSION", "That PHP version is not installed.", 400);
    if (input.type === "nodejs" && !options.nodeVersions.includes(input.nodeVersion))
      throw new AppError("INVALID_RUNTIME_VERSION", "That Node.js version is not supported.", 400);
    if (input.type === "python" && !options.pythonVersions.includes(input.pythonVersion))
      throw new AppError("INVALID_RUNTIME_VERSION", "That Python version is not supported.", 400);
    const args = [
      `site:add:${input.type}`,
      `--domainName=${input.domain}`,
      `--siteUser=${input.siteUser}`,
      `--siteUserPassword=${input.siteUserPassword}`,
    ];
    if (input.type === "php") args.push(`--phpVersion=${input.phpVersion}`, `--vhostTemplate=${input.vhostTemplate}`);
    if (input.type === "nodejs") args.push(`--nodejsVersion=${input.nodeVersion}`, `--appPort=${input.appPort}`);
    if (input.type === "python") args.push(`--pythonVersion=${input.pythonVersion}`, `--appPort=${input.appPort}`);
    if (input.type === "reverse-proxy") args.push(`--reverseProxyUrl=${input.reverseProxyUrl}`);
    try {
      await this.run("/usr/bin/clpctl", args, { timeout: 90_000 });
    } catch (error) {
      if (error instanceof AppError && error.code === "REQUEST_TIMEOUT") throw error;
      throw new AppError("SITE_CREATION_FAILED", "CloudPanel could not create the website.", 502);
    }
    return {
      id: `live-${input.domain}`,
      domain: input.domain,
      type: input.type,
      siteUser: input.siteUser,
      status: "active",
      createdAt: new Date().toISOString(),
      url: `https://${input.domain}`,
    };
  }

  async updateSite(
    session: CloudPanelSession,
    domain: string,
    input: {
      rootDirectory?: string;
      runtimeVersion?: string;
      appPort?: number;
      reverseProxyUrl?: string;
    },
  ) {
    const { panelAdmin } = await this.requireSiteAccess(session, domain);
    const result = await this.bridge({
      action: "update-site",
      username: this.sessionUser(session),
      domain,
      settings: input,
      panelAdmin,
    });
    if (!result.ok || !result.site)
      throw new AppError("SITE_UPDATE_FAILED", "CloudPanel could not update the website.", 502);
    return result.site;
  }

  async deleteSite(session: CloudPanelSession, domain: string) {
    await this.requireSiteAccess(session, domain);
    await this.run("/usr/bin/clpctl", ["site:delete", `--domainName=${domain}`, "--force"], {
      timeout: 90_000,
    });
  }

  async assignSite(session: CloudPanelSession, domain: string) {
    const result = await this.bridge({
      action: "assign-site",
      username: this.sessionUser(session),
      domain,
    });
    if (!result.ok)
      throw new AppError("SITE_UPDATE_FAILED", "The website could not be assigned to your account.", 502);
  }

  async getSiteSection(session: CloudPanelSession, domain: string, section: string) {
    const result = await this.bridge({
      action: "site-section",
      username: this.sessionUser(session),
      domain,
      section,
    });
    if (!result.ok)
      throw new AppError("SITE_NOT_FOUND", "Website section could not be loaded.", 404);
    return result.data;
  }

  async manageSiteSection(
    session: CloudPanelSession,
    domain: string,
    section: string,
    input: Record<string, unknown>,
  ) {
    const { panelAdmin } = await this.requireSiteAccess(session, domain);
    const action = String(input.action ?? "");
    if (panelAdmin && section === "databases" && action === "delete") {
      // clpctl db:delete is addressed by database name alone, so confirm the
      // database actually belongs to this (already authorized) site first.
      const data = (await this.getSiteSection(session, domain, "databases")) as {
        items?: { name?: string }[];
      };
      if (!data?.items?.some((item) => item.name === String(input.name)))
        throw new AppError("FORBIDDEN", "That database does not belong to this website.", 403);
    }
    if (section === "databases" && action === "add") {
      await this.run("/usr/bin/clpctl", [
        "db:add",
        `--domainName=${domain}`,
        `--databaseName=${String(input.name)}`,
        `--databaseUserName=${String(input.username)}`,
        `--databaseUserPassword=${String(input.password)}`,
      ], { timeout: 90_000 });
    } else if (section === "databases" && action === "delete") {
      await this.run("/usr/bin/clpctl", ["db:delete", `--databaseName=${String(input.name)}`, "--force"], { timeout: 90_000 });
    } else if (section === "certificates" && action === "lets-encrypt") {
      const args = ["lets-encrypt:install:certificate", `--domainName=${domain}`];
      if (input.subjectAlternativeName) args.push(`--subjectAlternativeName=${String(input.subjectAlternativeName)}`);
      await this.run("/usr/bin/clpctl", args, { timeout: 90_000 });
    } else {
      // Site actions (npm install, builds, docker compose…) legitimately run
      // for minutes; everything else stays on the short default timeout.
      const result = await this.bridge({
        action: "manage-section",
        username: this.sessionUser(session),
        domain,
        section,
        operation: input,
        panelAdmin,
      }, section === "actions" ? 1_850_000 : section === "file-manager" ? 620_000 : section === "git" ? 300_000 : undefined);
      if (!result.ok)
        throw siteSectionBridgeError(result);
      if (result.data !== undefined) return result.data;
    }
    return this.getSiteSection(session, domain, section);
  }

  async getServerResources(session: CloudPanelSession) {
    const result = await this.bridge(
      { action: "server-resources", username: this.sessionUser(session) },
      60_000,
    );
    if (!result.ok || !result.data)
      throw new AppError("FORBIDDEN", "Server resources are available to administrators only.", 403);
    return result.data as ServerResources;
  }

  async getServerInfo(session: CloudPanelSession) {
    const result = await this.bridge(
      { action: "server-info", username: this.sessionUser(session) },
    );
    if (!result.ok || !result.data)
      throw new AppError("FORBIDDEN", "Server information is available to administrators only.", 403);
    return result.data as ServerInfo;
  }

  async updateProfile(session: CloudPanelSession, input: UpdateProfileInput) {
    const username = this.sessionUser(session);
    if (input.action === "change-password") {
      // Verify the current password before resetting; clpctl itself has no
      // notion of "change with verification".
      const check = await this.bridge({ action: "login", username, password: input.currentPassword });
      if (!check.ok)
        throw new AppError("INVALID_CREDENTIALS", "Your current password is incorrect.", 401);
      await this.run("/usr/bin/clpctl", ["user:reset:password", `--userName=${username}`, `--password=${input.newPassword}`]);
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
      throw new AppError("INVALID_REQUEST", "Your profile could not be updated.", 400);
    return result.user;
  }

  async logout() {}
}
