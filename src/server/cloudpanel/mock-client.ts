import { randomUUID } from "node:crypto";
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

type MockAccount = {
  password: string;
  user: CloudPanelUser;
  twoFactor?: boolean;
  siteIds: string[];
};
const accounts: Record<string, MockAccount> = {
  admin: {
    password: "admin123",
    user: {
      id: "usr_admin",
      username: "admin",
      displayName: "Alex Morgan",
      role: "admin",
      canCreateSites: true,
    },
    siteIds: ["site_1", "site_2", "site_3"],
  },
  manager: {
    password: "manager123",
    user: {
      id: "usr_manager",
      username: "manager",
      displayName: "Site Manager",
      role: "site-manager",
      canCreateSites: true,
    },
    siteIds: ["site_1", "site_2", "site_3"],
  },
  user: {
    password: "user123",
    user: {
      id: "usr_user",
      username: "user",
      displayName: "Jamie Chen",
      role: "user",
      canCreateSites: false,
    },
    siteIds: ["site_2"],
  },
  empty: {
    password: "empty123",
    user: {
      id: "usr_empty",
      username: "empty",
      displayName: "New Account",
      role: "user",
      canCreateSites: false,
    },
    siteIds: [],
  },
  mfa: {
    password: "mfa123",
    user: {
      id: "usr_mfa",
      username: "mfa",
      displayName: "MFA Admin",
      role: "admin",
      canCreateSites: true,
    },
    siteIds: ["site_1", "site_2", "site_3"],
    twoFactor: true,
  },
};

const initialSites: CloudPanelSite[] = [
  {
    id: "site_1",
    domain: "northstar.studio",
    type: "php",
    runtimeVersion: "PHP 8.4",
    siteUser: "northstar",
    application: "WordPress",
    status: "active",
    createdAt: "2026-06-18T10:00:00Z",
    url: "https://northstar.studio",
  },
  {
    id: "site_2",
    domain: "api.harbor.dev",
    type: "nodejs",
    runtimeVersion: "Node.js 22",
    siteUser: "harbor-api",
    application: "Node.js",
    status: "active",
    createdAt: "2026-06-24T10:00:00Z",
    url: "https://api.harbor.dev",
  },
  {
    id: "site_3",
    domain: "docs.oakfield.io",
    type: "static",
    siteUser: "oakfield",
    application: "Static HTML",
    status: "active",
    createdAt: "2026-07-01T10:00:00Z",
    url: "https://docs.oakfield.io",
  },
];

const globalMock = globalThis as typeof globalThis & {
  __panelMockSites?: CloudPanelSite[];
};
const sites = (globalMock.__panelMockSites ??= structuredClone(initialSites));

function accountFor(session: CloudPanelSession) {
  const username = session.cookies.mockUser;
  const account = username ? accounts[username] : undefined;
  if (!account)
    throw new AppError(
      "SESSION_EXPIRED",
      "Your session has expired. Please sign in again.",
      401,
    );
  return account;
}

const options: SiteCreationOptions = {
  allowedTypes: ["php", "nodejs", "static", "python", "reverse-proxy"],
  phpVersions: ["8.5", "8.4", "8.3", "8.2", "8.1"],
  nodeVersions: ["24", "22", "20", "18"],
  pythonVersions: ["3.12"],
  vhostTemplates: ["Generic", "Laravel", "Symfony", "WordPress"],
};

export class MockCloudPanelClient implements CloudPanelClient {
  async login(input: {
    username: string;
    password: string;
  }): Promise<CloudPanelLoginResult> {
    if (input.username === "offline")
      throw new AppError(
        "CLOUDPANEL_UNAVAILABLE",
        "CloudPanel could not be reached. Try again shortly.",
        503,
      );
    const account = accounts[input.username];
    if (!account || account.password !== input.password)
      throw new AppError(
        "INVALID_CREDENTIALS",
        "The user name or password is incorrect.",
        401,
      );
    const session: CloudPanelSession = {
      cookies: { mockUser: input.username },
      usernameHint: input.username,
    };
    if (account.twoFactor)
      return {
        status: "two-factor-required",
        session: { ...session, pendingTwoFactor: true },
      };
    return { status: "authenticated", session, user: account.user };
  }

  async verifyTwoFactor(input: {
    session: CloudPanelSession;
    code: string;
  }): Promise<CloudPanelLoginResult> {
    const account = accountFor(input.session);
    if (input.code !== "123456")
      throw new AppError(
        "INVALID_TWO_FACTOR_CODE",
        "That verification code is not valid.",
        401,
      );
    return {
      status: "authenticated",
      session: { ...input.session, pendingTwoFactor: false },
      user: account.user,
    };
  }

  async getCurrentUser(session: CloudPanelSession) {
    return accountFor(session).user;
  }

  async listSites(session: CloudPanelSession) {
    const account = accountFor(session);
    if (account.user.canCreateSites) return structuredClone(sites);
    return structuredClone(
      sites.filter((site) => account.siteIds.includes(site.id)),
    );
  }

  async getSiteCreationOptions(session: CloudPanelSession) {
    const account = accountFor(session);
    if (!account.user.canCreateSites)
      throw new AppError(
        "FORBIDDEN",
        "You do not have permission to create websites.",
        403,
      );
    return structuredClone(options);
  }

  async createSite(session: CloudPanelSession, input: CreateSiteInput) {
    const account = accountFor(session);
    if (!account.user.canCreateSites)
      throw new AppError(
        "FORBIDDEN",
        "You do not have permission to create websites.",
        403,
      );
    if (sites.some((site) => site.domain === input.domain))
      throw new AppError(
        "DOMAIN_ALREADY_EXISTS",
        "A website with this domain already exists.",
        409,
      );
    if (input.type === "php" && !options.phpVersions.includes(input.phpVersion))
      throw new AppError(
        "INVALID_RUNTIME_VERSION",
        "That PHP version is not supported.",
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
    const runtimeVersion =
      input.type === "php"
        ? `PHP ${input.phpVersion}`
        : input.type === "nodejs"
          ? `Node.js ${input.nodeVersion}`
          : input.type === "python"
            ? `Python ${input.pythonVersion}`
            : undefined;
    const site: CloudPanelSite = {
      id: randomUUID(),
      domain: input.domain,
      type: input.type,
      runtimeVersion,
      siteUser: input.siteUser,
      status: "active",
      createdAt: new Date().toISOString(),
      url: `https://${input.domain}`,
    };
    sites.unshift(site);
    return structuredClone(site);
  }

  async logout() {}
}

export function resetMockSites() {
  sites.splice(0, sites.length, ...structuredClone(initialSites));
}
