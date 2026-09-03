import type { VpnManageInput, VpnManageResult, VpnState } from "./vpn";

export type SiteType =
  "php" | "nodejs" | "static" | "python" | "reverse-proxy" | "docker";

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
  mfa?: boolean;
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

export type SiteSectionExecutionOptions = {
  signal?: AbortSignal;
};

export type SiteReleaseOperation =
  | { action: "list" }
  | {
      action: "deploy";
      artifactPath: string;
      artifactName: string;
      expectedSha256: string;
      releaseId: string;
      stripComponents: 0 | 1;
      plan: "node" | "static-build" | "php" | "python";
      requiredPaths: string[];
      healthPath: string;
    }
  | {
      action: "rollback";
      releaseId: string;
      plan: "node" | "static-build" | "php" | "python";
      healthPath: string;
    };

export type SiteRecoveryOperation =
  | { action: "diagnose-proxy" }
  | {
      action:
        | "repair-site-acl"
        | "restart-rootless-runtime"
        | "recover-rootless-migration";
    };

export type SiteDatastoreCheck = {
  path: string;
  field: string;
  comparison: "equal" | "minimum";
  expected: number;
};

export type SiteDatastoreOperation =
  | {
      action: "inspect";
      driver: "lancedb";
      path: string;
    }
  | {
      action: "create-snapshot";
      driver: "lancedb";
      path: string;
      include: string[];
      exclude: string[];
      readyPath: string;
    }
  | {
      action: "restore-snapshot";
      driver: "lancedb";
      path: string;
      snapshotId: string;
      include: string[];
      exclude: string[];
      readyPath: string;
      checks: SiteDatastoreCheck[];
    };

export type SiteEndpointPort = {
  port: number;
  address: string;
  process?: string;
};

export type SiteEndpointProbe = {
  port: number;
  owned: boolean;
  loopback: boolean;
  reachable: boolean;
  httpStatus?: number;
  detail: string;
};

export type SiteEndpointOperation =
  | { action: "list" }
  | { action: "verify"; port: number; endpointDomain?: string };

export type SiteEndpointResult = {
  ports?: SiteEndpointPort[];
  probe?: SiteEndpointProbe;
  checkedAt: string;
};

export interface CloudPanelSite {
  id: string;
  domain: string;
  type?: SiteType;
  runtimeVersion?: string;
  siteUser?: string;
  application?: string;
  applicationRootDirectory?: string;
  rootDirectory?: string;
  appPort?: number;
  reverseProxyUrl?: string;
  status?: "active" | "inactive" | "unknown";
  createdAt?: string;
  label?: string;
  category?: string;
  categoryLabel?: string;
  categoryOrder?: number;
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
  reservedPorts: number[];
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

export type ServerResourceSource = "owner" | "path" | "container" | "port";

export interface ServerResourceWebsite {
  domain: string;
  siteUser: string;
  type: SiteType;
  cpuPercent: number;
  memoryBytes: number;
  processes: number;
  diskBytes?: number | null;
  diskShared: boolean;
  sources: ServerResourceSource[];
}

export interface ServerResourceRemainder {
  cpuPercent: number;
  memoryBytes: number;
  processes: number;
}

export interface ServerResources {
  generatedAt: string;
  uptimeSeconds: number;
  cpu: {
    cores: number;
    load1: number;
    load5: number;
    load15: number;
    usedPercent: number;
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    usedPercent: number;
  };
  swap: { totalBytes: number; usedBytes: number };
  disk: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    usedPercent: number;
    mount: string;
  };
  users: ServerResourceUser[];
  websites: ServerResourceWebsite[];
  shared: ServerResourceRemainder;
  system: ServerResourceRemainder;
  attribution: {
    memoryMethod: "pss" | "rss";
    note: string;
  };
}

export interface ServerStorageMetric {
  label: string;
  value: string;
  reclaimable?: string;
}

export interface ServerStorageDetail {
  label: string;
  bytes: number;
  note?: string;
  metrics?: ServerStorageMetric[];
}

export interface ServerStorageGroup {
  id:
    | "site-users"
    | "system-users"
    | "operating-system"
    | "system-services"
    | "administrator"
    | "temporary"
    | "other";
  label: string;
  bytes: number;
  description: string;
  details: ServerStorageDetail[];
}

export interface ServerStorageBreakdown {
  generatedAt: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  reservedBytes: number;
  accountedBytes: number;
  groups: ServerStorageGroup[];
  note: string;
  hygiene?: ServerStorageHygieneState;
}

export interface ServerStorageHygieneState {
  checkedAt?: string;
  lastCleanupAt?: string;
  mode?: "normal" | "emergency";
  beforePercent?: number;
  afterPercent?: number;
  reclaimedBytes?: number;
  blocked: boolean;
  reason?: string;
}

export type DatabaseExposure = {
  status: "private" | "provisioning" | "public" | "degraded";
  hostname?: string;
  port?: number;
  username?: string;
  permissions?: "ro" | "rw";
  accessMode?: "allowlist" | "internet";
  allowlist?: string[];
  tlsTrust?: "public" | "panelavo-ca";
  createdAt?: string;
  verifiedAt?: string;
  message?: string;
};

export interface ServerStorageCleanupSite {
  user: string;
  domains: string[];
  status: "cleaned" | "unchanged" | "skipped" | "failed";
  reclaimed: string;
  message: string;
}

export interface ServerStorageCleanupResult {
  generatedAt: string;
  reclaimedBytes: number;
  retainedBuildCacheBytes: number;
  sites: ServerStorageCleanupSite[];
  note: string;
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
  maintenance?: ServerMaintenanceState;
}

export interface ServerMaintenanceState {
  checkedAt: string;
  availableUpdates: number;
  securityUpdates: number;
  rebootRequired: boolean;
  unattendedUpgrades: boolean;
  lastPackageIndexAt?: string;
  status: "current" | "attention" | "reboot-required";
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
  manageUser(
    session: CloudPanelSession,
    input: Record<string, unknown>,
  ): Promise<void>;
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
      applicationRootDirectory?: string;
      rootDirectory?: string;
      runtimeVersion?: string;
      appPort?: number;
      reverseProxyUrl?: string;
      endpointParentDomain?: string;
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
    execution?: SiteSectionExecutionOptions,
  ): Promise<unknown>;
  manageSiteRelease(
    session: CloudPanelSession,
    domain: string,
    operation: SiteReleaseOperation,
    execution?: SiteSectionExecutionOptions,
  ): Promise<unknown>;
  manageSiteRecovery(
    session: CloudPanelSession,
    domain: string,
    operation: SiteRecoveryOperation,
    execution?: SiteSectionExecutionOptions,
  ): Promise<unknown>;
  manageSiteDatastore(
    session: CloudPanelSession,
    domain: string,
    operation: SiteDatastoreOperation,
    execution?: SiteSectionExecutionOptions,
  ): Promise<unknown>;
  manageSiteEndpoint(
    session: CloudPanelSession,
    domain: string,
    operation: SiteEndpointOperation,
  ): Promise<SiteEndpointResult>;
  getServerResources(session: CloudPanelSession): Promise<ServerResources>;
  getServerStorage(
    session: CloudPanelSession,
    refresh?: boolean,
  ): Promise<ServerStorageBreakdown>;
  reclaimServerStorage(
    session: CloudPanelSession,
  ): Promise<ServerStorageCleanupResult>;
  getServerInfo(session: CloudPanelSession): Promise<ServerInfo>;
  getVpnState(session: CloudPanelSession): Promise<VpnState>;
  manageVpn(
    session: CloudPanelSession,
    input: VpnManageInput,
  ): Promise<VpnManageResult>;
  updateProfile(
    session: CloudPanelSession,
    input: UpdateProfileInput,
  ): Promise<CloudPanelUser>;
  verifyPassword(session: CloudPanelSession, password: string): Promise<void>;
  manageMfa(
    session: CloudPanelSession,
    input: { action: "enable" | "disable"; secret?: string; code: string },
  ): Promise<CloudPanelUser>;
  logout(session: CloudPanelSession): Promise<void>;
}
