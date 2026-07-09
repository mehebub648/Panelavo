import type {
  CloudPanelClient,
  CloudPanelLoginResult,
  CloudPanelSite,
} from "@/types/cloudpanel";
import { decorateUser } from "@/server/auth/panel-roles";
import {
  getSiteTypeOverrides,
  removeSiteTypeOverride,
  setSiteTypeOverride,
} from "@/server/sites/site-type-overlay";
import { removeSiteMeta } from "@/server/sites/site-meta";
import { LiveCloudPanelClient } from "./live-client";

async function withSiteTypes(sites: CloudPanelSite[]) {
  const overrides = await getSiteTypeOverrides();
  return sites.map((site) => {
    const type = overrides[site.domain.toLowerCase()];
    return type
      ? {
          ...site,
          type,
          application: type === "docker" ? "Docker" : site.application,
        }
      : site;
  });
}

// Every user object leaving the client carries the panel role overlay
// (panelRole + effective canCreateSites), so routes and pages never see the
// raw CloudPanel role alone. Sites are decorated with the local site-type
// overlay ("docker" sites are reverse proxies inside CloudPanel).
function withPanelRoles(inner: CloudPanelClient): CloudPanelClient {
  const decorated = async (result: CloudPanelLoginResult) =>
    result.status === "authenticated"
      ? { ...result, user: await decorateUser(result.user) }
      : result;
  return {
    login: async (input) => decorated(await inner.login(input)),
    verifyTwoFactor: async (input) =>
      decorated(await inner.verifyTwoFactor(input)),
    getCurrentUser: async (session) =>
      decorateUser(await inner.getCurrentUser(session)),
    listUsers: async (session) =>
      Promise.all((await inner.listUsers(session)).map(decorateUser)),
    listSites: async (session) => withSiteTypes(await inner.listSites(session)),
    manageUser: inner.manageUser.bind(inner),
    getSiteCreationOptions: inner.getSiteCreationOptions.bind(inner),
    createSite: async (session, input) => {
      if (input.type !== "docker") return inner.createSite(session, input);
      // Docker sites are backed by a CloudPanel reverse proxy pointing at the
      // published container port on localhost.
      const site = await inner.createSite(session, {
        type: "reverse-proxy",
        domain: input.domain,
        reverseProxyUrl: `http://127.0.0.1:${input.appPort}`,
        siteUser: input.siteUser,
        siteUserPassword: input.siteUserPassword,
      });
      await setSiteTypeOverride(input.domain, "docker");
      return {
        ...site,
        type: "docker",
        appPort: input.appPort,
        application: "Docker",
      };
    },
    updateSite: inner.updateSite.bind(inner),
    deleteSite: async (session, domain) => {
      await inner.deleteSite(session, domain);
      await removeSiteTypeOverride(domain).catch(() => undefined);
      // Release the reserved site id and clean up the system-subdomain DNS
      // record (best-effort; the site itself is already gone).
      await removeSiteMeta(domain).catch(() => undefined);
    },
    assignSite: inner.assignSite.bind(inner),
    getSiteSection: inner.getSiteSection.bind(inner),
    manageSiteSection: inner.manageSiteSection.bind(inner),
    getServerResources: inner.getServerResources.bind(inner),
    getServerInfo: inner.getServerInfo.bind(inner),
    updateProfile: async (session, input) =>
      decorateUser(await inner.updateProfile(session, input)),
    logout: inner.logout.bind(inner),
  };
}

let client: CloudPanelClient | undefined;

export function getCloudPanelClient() {
  return (client ??= withPanelRoles(new LiveCloudPanelClient()));
}
