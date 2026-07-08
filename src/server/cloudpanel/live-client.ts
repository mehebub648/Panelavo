import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import type {
  CloudPanelClient,
  CloudPanelLoginResult,
  CloudPanelSession,
  CloudPanelSite,
  CloudPanelUser,
  CreateSiteInput,
  SiteCreationOptions,
  SiteType,
} from "@/types/cloudpanel";
import { AppError } from "./errors";

type HttpResult = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

function decode(value: string) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function inputValue(html: string, name: string) {
  const tag = html.match(
    new RegExp(`<input[^>]+name=["']${name}["'][^>]*>`, "i"),
  )?.[0];
  return tag?.match(/value=["']([^"']*)["']/i)?.[1];
}
function formDetails(html: string) {
  for (const form of html.matchAll(
    /<form[^>]*action=["']([^"']+)["'][^>]*>[\s\S]*?<\/form>/gi,
  )) {
    const codeTag = form[0].match(
      /<input[^>]+name=["']([^"']*(?:code|totp|auth|otp)[^"']*)["'][^>]*>/i,
    );
    if (codeTag)
      return {
        action: form[1],
        codeField: codeTag[1],
        csrf: inputValue(form[0], "_csrf_token"),
      };
  }
  return null;
}
function updateCookies(
  session: CloudPanelSession,
  headers: http.IncomingHttpHeaders,
) {
  for (const raw of headers["set-cookie"] ?? []) {
    const pair = raw.split(";", 1)[0];
    const index = pair.indexOf("=");
    if (index > 0)
      session.cookies[pair.slice(0, index)] = pair.slice(index + 1);
  }
}

export class LiveCloudPanelClient implements CloudPanelClient {
  private readonly base = new URL(
    process.env.CLOUDPANEL_BASE_URL ?? "https://127.0.0.1:8443",
  );
  private readonly verifyTls = process.env.CLOUDPANEL_TLS_VERIFY !== "false";

  private request(
    path: string,
    session: CloudPanelSession,
    options: {
      method?: string;
      body?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    return new Promise<HttpResult>((resolve, reject) => {
      if (!this.verifyTls && process.env.NODE_ENV === "production")
        return reject(
          new AppError(
            "CLOUDPANEL_UNAVAILABLE",
            "TLS verification cannot be disabled in production.",
            503,
          ),
        );
      const url = new URL(path, this.base);
      if (url.origin !== this.base.origin)
        return reject(
          new AppError(
            "CLOUDPANEL_VERSION_UNSUPPORTED",
            "CloudPanel returned an unexpected redirect.",
            502,
          ),
        );
      const transport = url.protocol === "https:" ? https : http;
      const request = transport.request(
        url,
        {
          method: options.method ?? "GET",
          rejectUnauthorized: this.verifyTls,
          timeout: 12_000,
          headers: {
            accept: "text/html",
            "user-agent": "ServerPanel/0.1",
            cookie: Object.entries(session.cookies)
              .map(([k, v]) => `${k}=${v}`)
              .join("; "),
            ...options.headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= 2_000_000) chunks.push(chunk);
            else response.destroy();
          });
          response.on("end", () => {
            updateCookies(session, response.headers);
            resolve({
              status: response.statusCode ?? 500,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      request.on("timeout", () =>
        request.destroy(
          new AppError(
            "REQUEST_TIMEOUT",
            "CloudPanel took too long to respond.",
            504,
          ),
        ),
      );
      request.on("error", (error) =>
        reject(
          error instanceof AppError
            ? error
            : new AppError(
                "CLOUDPANEL_UNAVAILABLE",
                "CloudPanel could not be reached.",
                503,
              ),
        ),
      );
      if (options.body) request.end(options.body);
      else request.end();
    });
  }

  private async page(
    path: string,
    session: CloudPanelSession,
  ): Promise<HttpResult> {
    const result = await this.request(path, session);
    if (
      result.status >= 300 &&
      result.status < 400 &&
      result.headers.location
    ) {
      if (new URL(result.headers.location, this.base).pathname === "/login")
        throw new AppError(
          "SESSION_EXPIRED",
          "Your CloudPanel session has expired.",
          401,
        );
      return this.page(result.headers.location, session);
    }
    return result;
  }

  private userFromHtml(
    html: string,
    session: CloudPanelSession,
  ): CloudPanelUser {
    const lower = decode(html).toLowerCase();
    const role = lower.includes("site manager")
      ? "site-manager"
      : /\badmin(?:istrator)?\b/.test(lower)
        ? "admin"
        : lower.includes("role user")
          ? "user"
          : "unknown";
    const canCreateSites =
      role === "admin" ||
      role === "site-manager" ||
      /href=["'][^"']*(?:site[^"']*(?:add|new)|(?:add|new)[^"']*site)/i.test(
        html,
      );
    return {
      id: session.usernameHint ?? "cloudpanel-user",
      username: session.usernameHint ?? "CloudPanel user",
      role,
      canCreateSites,
    };
  }

  async login(input: {
    username: string;
    password: string;
  }): Promise<CloudPanelLoginResult> {
    const session: CloudPanelSession = {
      cookies: {},
      usernameHint: input.username,
    };
    const loginPage = await this.request("/login", session);
    const csrf = inputValue(loginPage.body, "_csrf_token");
    if (!csrf)
      throw new AppError(
        "CLOUDPANEL_VERSION_UNSUPPORTED",
        "The installed CloudPanel login form is not compatible.",
        502,
      );
    const body = new URLSearchParams({
      userName: input.username,
      password: input.password,
      _csrf_token: csrf,
      submit: "",
    }).toString();
    const posted = await this.request("/login", session, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(Buffer.byteLength(body)),
        referer: new URL("/login", this.base).href,
      },
    });
    const location = posted.headers.location;
    if (!location)
      throw new AppError(
        "CLOUDPANEL_VERSION_UNSUPPORTED",
        "CloudPanel returned an unexpected login response.",
        502,
      );
    if (new URL(location, this.base).pathname === "/login")
      throw new AppError(
        "INVALID_CREDENTIALS",
        "The user name or password is incorrect.",
        401,
      );
    const next = await this.page(location, session);
    const details = formDetails(next.body);
    if (details?.codeField) {
      return {
        status: "two-factor-required",
        session: {
          ...session,
          pendingTwoFactor: true,
          twoFactorPath: details.action,
          twoFactorField: details.codeField,
          twoFactorCsrf: details.csrf,
        },
      };
    }
    return {
      status: "authenticated",
      session,
      user: this.userFromHtml(next.body, session),
    };
  }

  async verifyTwoFactor(input: {
    session: CloudPanelSession;
    code: string;
  }): Promise<CloudPanelLoginResult> {
    const { session } = input;
    if (!session.twoFactorPath || !session.twoFactorField)
      throw new AppError(
        "SESSION_EXPIRED",
        "The verification challenge has expired.",
        401,
      );
    const values: Record<string, string> = {
      [session.twoFactorField]: input.code,
    };
    if (session.twoFactorCsrf) values._csrf_token = session.twoFactorCsrf;
    const body = new URLSearchParams(values).toString();
    const response = await this.request(session.twoFactorPath, session, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(Buffer.byteLength(body)),
      },
    });
    const path = response.headers.location;
    if (
      !path ||
      /(?:two-factor|mfa|login)/i.test(new URL(path, this.base).pathname)
    )
      throw new AppError(
        "INVALID_TWO_FACTOR_CODE",
        "That verification code is not valid.",
        401,
      );
    const page = await this.page(path, session);
    const complete = {
      ...session,
      pendingTwoFactor: false,
      twoFactorPath: undefined,
      twoFactorField: undefined,
      twoFactorCsrf: undefined,
    };
    return {
      status: "authenticated",
      session: complete,
      user: this.userFromHtml(page.body, complete),
    };
  }

  async getCurrentUser(session: CloudPanelSession) {
    const page = await this.page("/", session);
    return this.userFromHtml(page.body, session);
  }

  private parseSites(html: string): CloudPanelSite[] {
    const table = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)].find(
      (match) => /domain|site user|runtime|type/i.test(decode(match[1])),
    );
    if (!table) return [];
    const rows = [...table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    const headers = [
      ...(rows.shift()?.[1] ?? "").matchAll(
        /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi,
      ),
    ].map((cell) => decode(cell[1]).toLowerCase());
    return rows.flatMap((row, index) => {
      const cells = [
        ...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi),
      ].map((cell) => decode(cell[1]));
      const value = (name: RegExp) =>
        cells[headers.findIndex((header) => name.test(header))];
      const domain = value(/domain|site/)
        ?.replace(/^https?:\/\//, "")
        .split(/[\s/]/)[0];
      if (!domain || !domain.includes(".")) return [];
      const typeText = value(/type|application/)?.toLowerCase() ?? "";
      const type: SiteType | undefined = typeText.includes("node")
        ? "nodejs"
        : typeText.includes("php")
          ? "php"
          : typeText.includes("python")
            ? "python"
            : typeText.includes("static")
              ? "static"
              : typeText.includes("proxy")
                ? "reverse-proxy"
                : undefined;
      return [
        {
          id: `live-${index}-${domain}`,
          domain,
          type,
          runtimeVersion: value(/version|runtime/),
          siteUser: value(/site user|user/),
          application: value(/application|template/),
          status: /inactive|disabled/i.test(value(/status/) ?? "")
            ? "inactive"
            : "active",
          createdAt: value(/created|date/),
          url: `https://${domain}`,
        },
      ];
    });
  }

  async listSites(session: CloudPanelSession) {
    const home = await this.page("/", session);
    let sites = this.parseSites(home.body);
    if (sites.length) return sites;
    const links = [
      ...home.body.matchAll(/href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi),
    ];
    const siteLink = links.find(
      (link) =>
        /sites?/i.test(decode(link[2])) && !/(add|new|create)/i.test(link[1]),
    )?.[1];
    if (!siteLink)
      throw new AppError(
        "CLOUDPANEL_VERSION_UNSUPPORTED",
        "Could not discover the authorized site-list page for this CloudPanel version.",
        502,
      );
    sites = this.parseSites((await this.page(siteLink, session)).body);
    return sites;
  }

  async getSiteCreationOptions(
    session: CloudPanelSession,
  ): Promise<SiteCreationOptions> {
    const user = await this.getCurrentUser(session);
    if (!user.canCreateSites)
      throw new AppError(
        "FORBIDDEN",
        "You do not have permission to create websites.",
        403,
      );
    const version = process.env.CLOUDPANEL_VERSION || "2.5.4";
    if (version !== "2.5.4")
      throw new AppError(
        "CLOUDPANEL_VERSION_UNSUPPORTED",
        `CloudPanel ${version} has not been validated by this adapter.`,
        502,
      );
    let phpVersions: string[] = [];
    try {
      phpVersions = (await readdir("/etc/php"))
        .filter((item) => /^\d+\.\d+$/.test(item))
        .sort()
        .reverse();
    } catch {}
    return {
      allowedTypes: ["php", "nodejs", "static", "python", "reverse-proxy"],
      phpVersions,
      nodeVersions: ["22", "20", "18", "16", "14", "12"],
      pythonVersions: ["3.12", "3.10", "3.9"],
      vhostTemplates: ["Generic"],
    };
  }

  async createSite(
    session: CloudPanelSession,
    input: CreateSiteInput,
  ): Promise<CloudPanelSite> {
    const user = await this.getCurrentUser(session);
    if (!user.canCreateSites)
      throw new AppError(
        "FORBIDDEN",
        "You do not have permission to create websites.",
        403,
      );
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
    const command = `site:add:${input.type}`;
    const args = [
      "/usr/bin/clpctlWrapper",
      command,
      `--domainName=${input.domain}`,
      `--siteUser=${input.siteUser}`,
      `--siteUserPassword=${input.siteUserPassword}`,
    ];
    if (input.type === "php")
      args.push(
        `--phpVersion=${input.phpVersion}`,
        `--vhostTemplate=${input.vhostTemplate}`,
      );
    if (input.type === "nodejs")
      args.push(
        `--nodejsVersion=${input.nodeVersion}`,
        `--appPort=${input.appPort}`,
      );
    if (input.type === "python")
      args.push(
        `--pythonVersion=${input.pythonVersion}`,
        `--appPort=${input.appPort}`,
      );
    if (input.type === "reverse-proxy")
      args.push(`--reverseProxyUrl=${input.reverseProxyUrl}`);
    await this.runCli(args);
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

  private runCli(args: string[]) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/sudo", args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      const collect = (chunk: Buffer) => {
        if (output.length < 16_000) output += chunk.toString("utf8");
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new AppError("REQUEST_TIMEOUT", "Site creation took too long.", 504),
        );
      }, 90_000);
      child.on("error", () => {
        clearTimeout(timeout);
        reject(
          new AppError(
            "SITE_CREATION_FAILED",
            "CloudPanel could not create the website.",
            502,
          ),
        );
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else if (/already exists|duplicate/i.test(output))
          reject(
            new AppError(
              "DOMAIN_ALREADY_EXISTS",
              "A website with this domain already exists.",
              409,
            ),
          );
        else
          reject(
            new AppError(
              "SITE_CREATION_FAILED",
              "CloudPanel could not create the website.",
              502,
            ),
          );
      });
    });
  }

  async logout(session: CloudPanelSession) {
    try {
      const home = await this.page("/", session);
      const link = [
        ...home.body.matchAll(/href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi),
      ].find((item) => /log\s*out/i.test(decode(item[2])))?.[1];
      if (link) await this.request(link, session);
    } catch {}
  }
}
