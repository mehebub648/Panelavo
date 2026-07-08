export type SiteType = "php" | "nodejs" | "static" | "python" | "reverse-proxy";

export interface CloudPanelUser {
  id: string;
  username: string;
  displayName?: string;
  role?: "admin" | "site-manager" | "user" | "unknown";
  canCreateSites: boolean;
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
    };

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
  logout(session: CloudPanelSession): Promise<void>;
}
