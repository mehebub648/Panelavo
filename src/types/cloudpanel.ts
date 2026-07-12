export type SiteType =
  | "php"
  | "nodejs"
  | "static"
  | "python"
  | "reverse-proxy"
  | "docker";

// Panel-level role model. CloudPanel natively stores admin / site-manager /
// user; the panel "admin" tier is a CloudPanel "user" elevated by a local
// overlay (see src/server/auth/panel-roles.ts):
//   super-admin — CloudPanel admin: everything, including user management.
//   manager     — CloudPanel site-manager: everything except user management.
//   admin       — creates sites; sees only assigned sites + sites they created.
//   user        — assigned sites only, read/manage nothing beyond them.
export type PanelRole = "super-admin" | "manager" | "admin" | "user";

export interface CloudPanelUser {
  id: string;
  username: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  role?: "admin" | "site-manager" | "user" | "unknown";
  panelRole?: PanelRole;
  canCreateSites: boolean;
  email?: string;
  timezone?: string | null;
  status?: boolean;
  sites?: string[];
}

export interface CloudPanelSession {
  cookies: Record<string, string>;
  usernameHint?: string;
  cliAuthenticated?: boolean;
  pendingTwoFactor?: boolean;
  twoFactorPath?: string;
  twoFactorField?: string;
  twoFactorCsrf?: string;
}

export interface CloudPanelSite {
  id: string;
  domain: string;
  type?: SiteType;
  runtimeVersion?: string;
  siteUser?: string;
  application?: string;
  rootDirectory?: string;
  appPort?: number;
  reverseProxyUrl?: string;
  status?: "active" | "inactive" | "unknown";
  createdAt?: string;
  url: string;
  meta?: {
    aliases?: string[];
    // Set on linked-service sites: the parent's system domain and the
    // operator-chosen service label (see src/server/sites/site-meta.ts).
    parent?: string;
    serviceName?: string;
  } & Record<string, unknown>;
}

export interface SiteCreationOptions {
  allowedTypes: SiteType[];
  phpVersions: string[];
  nodeVersions: string[];
  pythonVersions: string[];
  vhostTemplates: string[];
}

export type CreateSiteInput =
  | {
      type: "php";
      domain: string;
      phpVersion: string;
      vhostTemplate: string;
      siteUser: string;
      siteUserPassword: string;
    }
  | {
      type: "nodejs";
      domain: string;
      nodeVersion: string;
      appPort: number;
      siteUser: string;
      siteUserPassword: string;
    }
  | {
      type: "static";
      domain: string;
      siteUser: string;
      siteUserPassword: string;
    }
  | {
      type: "python";
      domain: string;
      pythonVersion: string;
      appPort: number;
      siteUser: string;
      siteUserPassword: string;
    }
  | {
      type: "reverse-proxy";
      domain: string;
      reverseProxyUrl: string;
      siteUser: string;
      siteUserPassword: string;
    }
  | {
      // Docker sites are stored in CloudPanel as reverse proxies to the
      // published container port; the panel keeps the "docker" type in a
      // local overlay (src/server/sites/site-type-overlay.ts).
      type: "docker";
      domain: string;
      appPort: number;
      siteUser: string;
      siteUserPassword: string;
    };

export interface ServerResourceUser {
  user: string;
  cpuPercent: number;
  memoryPercent: number;
  memoryBytes: number;
  processes: number;
  diskBytes?: number;
  domains?: string[];
}

export interface ServerResources {
  generatedAt: string;
  uptimeSeconds: number;
  cpu: { cores: number; load1: number; load5: number; load15: number; usedPercent: number };
  memory: { totalBytes: number; usedBytes: number; availableBytes: number; usedPercent: number };
  swap: { totalBytes: number; usedBytes: number };
  disk: { totalBytes: number; usedBytes: number; availableBytes: number; usedPercent: number; mount: string };
  users: ServerResourceUser[];
}

export interface ResourceHistoryPoint {
  t: number;
  cpu: number;
  mem: number;
  disk: number;
}

export type UpdateProfileInput =
  | {
      action: "update";
      firstName?: string;
      lastName?: string;
      email?: string;
      timezone?: string;
    }
  | { action: "change-password"; currentPassword: string; newPassword: string };

export interface ServerInfo {
  hostname: string;
  os: string;
  kernel: string;
  arch: string;
  ip: string;
  uptimeSeconds: number;
  cpuModel: string;
  cpuCores: number;
  memoryTotalBytes: number;
  diskTotalBytes: number;
  software: { name: string; version: string }[];
}

export type CloudPanelLoginResult =
  | {
      status: "authenticated";
      session: CloudPanelSession;
      user: CloudPanelUser;
    }
  | { status: "two-factor-required"; session: CloudPanelSession };

export interface CloudPanelClient {
  login(input: {
    username: string;
    password: string;
  }): Promise<CloudPanelLoginResult>;
  verifyTwoFactor(input: {
    session: CloudPanelSession;
    code: string;
  }): Promise<CloudPanelLoginResult>;
  getCurrentUser(session: CloudPanelSession): Promise<CloudPanelUser>;
  listSites(session: CloudPanelSession): Promise<CloudPanelSite[]>;
  listUsers(session: CloudPanelSession): Promise<CloudPanelUser[]>;
  manageUser(session: CloudPanelSession, input: Record<string, unknown>): Promise<void>;
  getSiteCreationOptions(
    session: CloudPanelSession,
  ): Promise<SiteCreationOptions>;
  createSite(
    session: CloudPanelSession,
    input: CreateSiteInput,
  ): Promise<CloudPanelSite>;
  updateSite(
    session: CloudPanelSession,
    domain: string,
    input: {
      rootDirectory?: string;
      runtimeVersion?: string;
      appPort?: number;
      reverseProxyUrl?: string;
    },
  ): Promise<CloudPanelSite>;
  deleteSite(session: CloudPanelSession, domain: string): Promise<void>;
  assignSite(session: CloudPanelSession, domain: string): Promise<void>;
  getSiteSection(
    session: CloudPanelSession,
    domain: string,
    section: string,
  ): Promise<unknown>;
  manageSiteSection(
    session: CloudPanelSession,
    domain: string,
    section: string,
    input: Record<string, unknown>,
  ): Promise<unknown>;
  getServerResources(session: CloudPanelSession): Promise<ServerResources>;
  getServerInfo(session: CloudPanelSession): Promise<ServerInfo>;
  updateProfile(
    session: CloudPanelSession,
    input: UpdateProfileInput,
  ): Promise<CloudPanelUser>;
  logout(session: CloudPanelSession): Promise<void>;
}
