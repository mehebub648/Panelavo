import { requireUser, requireUserOrRedirect } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import type { CloudPanelSite } from "@/types/cloudpanel";
import { getSiteMeta } from "@/server/sites/site-meta";
import type { CloudPanelSession, CloudPanelUser } from "@/types/cloudpanel";

type UserSession = Awaited<ReturnType<typeof requireUser>>;

export type PanelActor = {
  user: CloudPanelUser;
  cloudPanel: CloudPanelSession;
  authentication: "session" | "api-token" | "mcp";
  credentialId?: string;
};

export function panelActorFromSession(session: UserSession): PanelActor {
  return {
    user: session.user,
    cloudPanel: session.record.cloudPanel,
    authentication: "session",
    credentialId: session.id,
  };
}

function findSite(sites: CloudPanelSite[], domain: string) {
  const normalized = domain.toLowerCase();
  return sites.find((site) => site.domain.toLowerCase() === normalized);
}

async function accessibleSite(session: UserSession, domain: string) {
  const access = await accessibleSiteForActor(
    panelActorFromSession(session),
    domain,
  );
  return { session, ...access };
}

export function canWriteSites(user: CloudPanelUser) {
  return user.canCreateSites || user.panelRole === "admin";
}

export async function accessibleSiteForActor(
  actor: PanelActor,
  domain: string,
) {
  const client = getCloudPanelClient();
  const sites = await client.listSites(actor.cloudPanel);
  const site = findSite(sites, domain);
  if (!site) throw new AppError("SITE_NOT_FOUND", "Website not found.", 404);
  return { actor, site, sites, client };
}

export async function writableSiteForActor(actor: PanelActor, domain: string) {
  const access = await accessibleSiteForActor(actor, domain);
  if (!canWriteSites(actor.user))
    throw new AppError(
      "FORBIDDEN",
      "You do not have permission to modify websites.",
      403,
    );
  return access;
}

export async function accessibleDomainTargetForActor(
  actor: PanelActor,
  targetDomain: string,
  options: { write?: boolean } = {},
) {
  const client = getCloudPanelClient();
  const sites = await client.listSites(actor.cloudPanel);
  const target = targetDomain.toLowerCase();
  let site = findSite(sites, target);
  if (!site) {
    const metadata = await Promise.all(
      sites.map(async (candidate) => ({
        site: candidate,
        meta: await getSiteMeta(candidate.domain),
      })),
    );
    site = metadata.find(({ meta }) => meta?.aliases.includes(target))?.site;
  }
  if (!site) throw new AppError("SITE_NOT_FOUND", "Website not found.", 404);
  if (options.write && !canWriteSites(actor.user))
    throw new AppError(
      "FORBIDDEN",
      "You do not have permission to modify websites.",
      403,
    );
  return { actor, site, sites, client, target };
}

export async function requireAccessibleSite(
  domain: string,
  options: { allowDuringUpdate?: boolean } = {},
) {
  return accessibleSite(await requireUser(options), domain);
}

export async function requireAccessibleSiteOrRedirect(
  domain: string,
  options: { allowDuringUpdate?: boolean } = {},
) {
  return accessibleSite(await requireUserOrRedirect(options), domain);
}

export async function requireWritableSite(
  domain: string,
  options: { allowDuringUpdate?: boolean } = {},
) {
  const access = await requireAccessibleSite(domain, options);
  if (!canWriteSites(access.session.user))
    throw new AppError(
      "FORBIDDEN",
      "You do not have permission to modify websites.",
      403,
    );
  return access;
}

export async function requireAccessibleDomainTarget(
  targetDomain: string,
  options: { write?: boolean; allowDuringUpdate?: boolean } = {},
) {
  const session = await requireUser({
    allowDuringUpdate: options.allowDuringUpdate,
  });
  const access = await accessibleDomainTargetForActor(
    panelActorFromSession(session),
    targetDomain,
    options,
  );
  return { session, ...access };
}
