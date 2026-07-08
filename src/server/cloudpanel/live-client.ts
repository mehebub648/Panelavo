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
  SiteCreationOptions,
} from "@/types/cloudpanel";
import { AppError } from "./errors";

type BridgeResult = {
  ok: boolean;
  code?: string | null;
  user?: CloudPanelUser & { mfa?: boolean };
  site?: CloudPanelSite;
  sites?: CloudPanelSite[];
  data?: unknown;
};

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
        if (stdout.length < 64_000) stdout += chunk.toString("utf8");
      };
      const collectStderr = (chunk: Buffer) => {
        if (stderr.length < 64_000) stderr += chunk.toString("utf8");
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
        else reject(new AppError(
          signal === "SIGKILL" ? "REQUEST_TIMEOUT" : "CLOUDPANEL_UNAVAILABLE",
          signal === "SIGKILL" ? "CloudPanel CLI took too long to respond." :
            (/already exists|duplicate/i.test(stderr) ? "A website with this domain already exists." : "CloudPanel CLI command failed."),
          signal === "SIGKILL" ? 504 : 503,
        ));
      });
    });
  }

  private async bridge(input: Record<string, unknown>): Promise<BridgeResult> {
    const script = join(process.cwd(), "scripts", "cloudpanel-bridge.php");
    const output = await this.run("/usr/bin/php", [script], {
      input: JSON.stringify(input),
    });
    try {
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

  async getSiteCreationOptions(session: CloudPanelSession): Promise<SiteCreationOptions> {
    const user = await this.getCurrentUser(session);
    if (!user.canCreateSites)
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
      allowedTypes: ["php", "nodejs", "static", "python", "reverse-proxy"],
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
    const user = await this.getCurrentUser(session);
    if (!user.canCreateSites)
      throw new AppError("FORBIDDEN", "You do not have permission to modify websites.", 403);
    const result = await this.bridge({
      action: "update-site",
      username: this.sessionUser(session),
      domain,
      settings: input,
    });
    if (!result.ok || !result.site)
      throw new AppError("SITE_UPDATE_FAILED", "CloudPanel could not update the website.", 502);
    return result.site;
  }

  async deleteSite(session: CloudPanelSession, domain: string) {
    const user = await this.getCurrentUser(session);
    if (!user.canCreateSites)
      throw new AppError("FORBIDDEN", "You do not have permission to delete websites.", 403);
    await this.run("/usr/bin/clpctl", ["site:delete", `--domainName=${domain}`, "--force"], {
      timeout: 90_000,
    });
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
    const user = await this.getCurrentUser(session);
    if (!user.canCreateSites)
      throw new AppError("FORBIDDEN", "You do not have permission to modify websites.", 403);
    const action = String(input.action ?? "");
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
      const result = await this.bridge({
        action: "manage-section",
        username: this.sessionUser(session),
        domain,
        section,
        operation: input,
      });
      if (!result.ok)
        throw new AppError("SITE_UPDATE_FAILED", "CloudPanel could not apply the change.", 502);
      if (result.data !== undefined) return result.data;
    }
    return this.getSiteSection(session, domain, section);
  }

  async logout() {}
}
