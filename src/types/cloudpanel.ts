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
  logout(session: CloudPanelSession): Promise<void>;
}
