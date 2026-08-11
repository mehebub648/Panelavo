import { requireUser, requireUserOrRedirect } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import type { CloudPanelSite } from "@/types/cloudpanel";
import { getSiteMeta } from "@/server/sites/site-meta";

type UserSession = Awaited<ReturnType<typeof requireUser>>;

function findSite(sites: CloudPanelSite[], domain: string) {
  const normalized = domain.toLowerCase();
  return sites.find((site) => site.domain.toLowerCase() === normalized);
}

async function accessibleSite(session: UserSession, domain: string) {
  const client = getCloudPanelClient();
  const sites = await client.listSites(session.record.cloudPanel);
  const site = findSite(sites, domain);
  if (!site)
    throw new AppError("SITE_NOT_FOUND", "Website not found.", 404);
  return { session, site, sites, client };
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
  if (
    !access.session.user.canCreateSites &&
    access.session.user.panelRole !== "admin"
  )
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
  const client = getCloudPanelClient();
  const sites = await client.listSites(session.record.cloudPanel);
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
  if (!site)
    throw new AppError("SITE_NOT_FOUND", "Website not found.", 404);
  if (
    options.write &&
    !session.user.canCreateSites &&
    session.user.panelRole !== "admin"
  )
    throw new AppError(
      "FORBIDDEN",
      "You do not have permission to modify websites.",
      403,
    );
  return { session, site, sites, client, target };
}
