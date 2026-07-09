import type {
  CloudPanelClient,
  CloudPanelLoginResult,
} from "@/types/cloudpanel";
import { decorateUser } from "@/server/auth/panel-roles";
import { LiveCloudPanelClient } from "./live-client";
import { MockCloudPanelClient } from "./mock-client";

// Every user object leaving the client carries the panel role overlay
// (panelRole + effective canCreateSites), so routes and pages never see the
// raw CloudPanel role alone.
function withPanelRoles(inner: CloudPanelClient): CloudPanelClient {
  const decorated = async (result: CloudPanelLoginResult) =>
    result.status === "authenticated"
      ? { ...result, user: await decorateUser(result.user) }
      : result;
  return {
    login: async (input) => decorated(await inner.login(input)),
    verifyTwoFactor: async (input) => decorated(await inner.verifyTwoFactor(input)),
    getCurrentUser: async (session) => decorateUser(await inner.getCurrentUser(session)),
    listUsers: async (session) =>
      Promise.all((await inner.listUsers(session)).map(decorateUser)),
    listSites: inner.listSites.bind(inner),
    manageUser: inner.manageUser.bind(inner),
    getSiteCreationOptions: inner.getSiteCreationOptions.bind(inner),
    createSite: inner.createSite.bind(inner),
    updateSite: inner.updateSite.bind(inner),
    deleteSite: inner.deleteSite.bind(inner),
    assignSite: inner.assignSite.bind(inner),
    getSiteSection: inner.getSiteSection.bind(inner),
    manageSiteSection: inner.manageSiteSection.bind(inner),
    logout: inner.logout.bind(inner),
  };
}

let client: CloudPanelClient | undefined;

export function getCloudPanelClient() {
  return (client ??= withPanelRoles(
    process.env.CLOUDPANEL_MODE === "live"
      ? new LiveCloudPanelClient()
      : new MockCloudPanelClient(),
  ));
}

export function setCloudPanelClientForTests(value?: CloudPanelClient) {
  client = value;
}
