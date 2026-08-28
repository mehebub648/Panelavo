import { randomInt } from "node:crypto";
import {
  createLinkedServiceSchema,
  updateProjectEndpointSchema,
} from "@/schemas/sites";
import type { PanelActor } from "@/server/auth/site-access";
import {
  accessibleSiteForActor,
  canWriteSites,
  writableSiteForActor,
} from "@/server/auth/site-access";
import { AppError } from "@/server/cloudpanel/errors";
import { getBaseDomain } from "@/server/settings/store";
import { issueSiteSsl, planSiteSsl } from "@/server/sites/ensure-ssl";
import { deleteManagedSite } from "@/server/sites/site-service";
import {
  allocateSiteId,
  getAllSiteMeta,
  getLinkedServiceMeta,
  getSiteMeta,
  removeSiteMeta,
  setSiteMeta,
  siteUserForId,
  systemDomainFor,
  type SiteMeta,
} from "@/server/sites/site-meta";
import type {
  CloudPanelClient,
  CloudPanelSite,
  SiteEndpointPort,
} from "@/types/cloudpanel";

function makeSiteUserPassword() {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%+=_-";
  return Array.from({ length: 24 }, () => chars[randomInt(chars.length)]).join(
    "",
  );
}

function portFromProxyUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") return;
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return Number.isInteger(port) && port >= 1 && port <= 65535
      ? port
      : undefined;
  } catch {
    return;
  }
}

function endpointPort(meta: SiteMeta, site?: CloudPanelSite) {
  return meta.targetPort ?? portFromProxyUrl(site?.reverseProxyUrl);
}

function assertParentMeta(meta: SiteMeta | null | undefined) {
  if (!meta)
    throw new AppError(
      "INVALID_REQUEST",
      "Project endpoints are only available for panel-created websites.",
      409,
    );
  if (meta.parent)
    throw new AppError(
      "INVALID_REQUEST",
      "A project endpoint cannot have endpoints of its own. Add it to the parent project instead.",
      400,
    );
  return meta;
}

function assertEndpointMeta(parentDomain: string, meta: SiteMeta | null) {
  if (!meta || meta.parent !== parentDomain)
    throw new AppError(
      "SITE_NOT_FOUND",
      "The project endpoint could not be found.",
      404,
    );
  return meta;
}

function isPortClaimed(
  port: number,
  allMeta: Record<string, SiteMeta>,
  sites: CloudPanelSite[],
  currentEndpoint?: string,
) {
  const current = currentEndpoint?.toLowerCase();
  const metadataConflict = Object.entries(allMeta).find(
    ([domain, meta]) => domain !== current && meta.targetPort === port,
  );
  const siteConflict = sites.find(
    (site) =>
      site.domain.toLowerCase() !== current &&
      (site.appPort === port ||
        portFromProxyUrl(site.reverseProxyUrl) === port),
  );
  return Boolean(metadataConflict || siteConflict);
}

function assertPortUnclaimed(
  port: number,
  allMeta: Record<string, SiteMeta>,
  sites: CloudPanelSite[],
  currentEndpoint?: string,
) {
  if (isPortClaimed(port, allMeta, sites, currentEndpoint))
    throw new AppError(
      "INVALID_REQUEST",
      `Port ${port} is reserved by another website or project endpoint.`,
      409,
    );
}

async function inspectPorts(
  client: CloudPanelClient,
  actor: PanelActor,
  parentDomain: string,
) {
  return client.manageSiteEndpoint(actor.cloudPanel, parentDomain, {
    action: "list",
  });
}

async function verifyPort(
  client: CloudPanelClient,
  actor: PanelActor,
  parentDomain: string,
  port: number,
  endpointDomain?: string,
) {
  const result = await client.manageSiteEndpoint(
    actor.cloudPanel,
    parentDomain,
    {
      action: "verify",
      port,
      endpointDomain,
    },
  );
  return (
    result.probe ?? {
      port,
      owned: false,
      loopback: false,
      reachable: false,
      detail: "The project endpoint could not be verified.",
    }
  );
}

function endpointView(
  domain: string,
  meta: SiteMeta,
  site: CloudPanelSite | undefined,
  ports: SiteEndpointPort[],
  assumeActive = false,
) {
  const targetPort = endpointPort(meta, site);
  const listener = ports.find((candidate) => candidate.port === targetPort);
  const pending = meta.pending === true || !site;
  return {
    domain,
    serviceName: meta.serviceName ?? domain,
    aliases: meta.aliases,
    targetPort,
    reverseProxyUrl: site?.reverseProxyUrl,
    status: pending
      ? "pending"
      : listener || assumeActive
        ? "active"
        : "unhealthy",
    listener,
    accessible: Boolean(site),
  };
}

export async function listLinkedServicesForActor(
  actor: PanelActor,
  requestedParentDomain: string,
) {
  const {
    site: parent,
    sites,
    client,
  } = await accessibleSiteForActor(actor, requestedParentDomain);
  const parentDomain = parent.domain.toLowerCase();
  const children = await getLinkedServiceMeta(parentDomain);
  const canInspectPorts = canWriteSites(actor.user);
  let detectedPorts: SiteEndpointPort[] = [];
  if (canInspectPorts)
    detectedPorts =
      (await inspectPorts(client, actor, parentDomain)).ports ?? [];
  const services = Object.entries(children).map(([domain, meta]) =>
    endpointView(
      domain,
      meta,
      sites.find((candidate) => candidate.domain.toLowerCase() === domain),
      detectedPorts,
      !canInspectPorts,
    ),
  );
  const allMeta = canInspectPorts ? await getAllSiteMeta() : {};
  const ports = detectedPorts.filter(
    (candidate) => !isPortClaimed(candidate.port, allMeta, sites),
  );
  return { services, ports };
}

export async function listProjectPortsForActor(
  actor: PanelActor,
  requestedParentDomain: string,
) {
  const { site, sites, client } = await writableSiteForActor(
    actor,
    requestedParentDomain,
  );
  const parentDomain = site.domain.toLowerCase();
  assertParentMeta(await getSiteMeta(parentDomain));
  const [result, allMeta] = await Promise.all([
    inspectPorts(client, actor, parentDomain),
    getAllSiteMeta(),
  ]);
  return {
    ...result,
    ports: (result.ports ?? []).filter(
      (candidate) => !isPortClaimed(candidate.port, allMeta, sites),
    ),
  };
}

export type LinkedServicePreparedDetails = {
  parent: string;
  serviceName: string;
  domain: string;
  siteId: number;
  targetPort: number;
};

async function activateEndpoint(
  actor: PanelActor,
  client: CloudPanelClient,
  details: LinkedServicePreparedDetails,
  meta: SiteMeta,
  serverIp: string,
) {
  const site = await client.createSite(actor.cloudPanel, {
    type: "reverse-proxy",
    domain: details.domain,
    siteUser: siteUserForId(details.siteId),
    siteUserPassword: makeSiteUserPassword(),
    reverseProxyUrl: `http://127.0.0.1:${details.targetPort}`,
  });
  const warnings: string[] = [];
  try {
    if (actor.user.panelRole === "admin")
      await client.assignSite(actor.cloudPanel, details.domain);
    await setSiteMeta(details.domain, {
      ...meta,
      targetPort: details.targetPort,
      pending: false,
    });
  } catch (error) {
    await client
      .deleteSite(actor.cloudPanel, details.domain)
      .catch(() => undefined);
    throw error;
  }

  if (meta.aliases.length) {
    try {
      await client.manageSiteSection(
        actor.cloudPanel,
        details.domain,
        "domains",
        {
          action: "sync",
          systemDomain: details.domain,
          aliases: meta.aliases,
          block: "none",
        },
      );
    } catch {
      warnings.push(
        "The endpoint was activated, but its domain aliases need to be saved again from the Domains tab.",
      );
    }
  }

  try {
    const plan = await planSiteSsl({
      userId: actor.user.id,
      systemDomain: details.domain,
      aliases: meta.aliases,
      serverIp,
      autoPoint: true,
    });
    warnings.push(...plan.warnings);
    void issueSiteSsl(actor.cloudPanel, details.domain, plan.san).catch(
      (error: unknown) => {
        console.error(
          `Let's Encrypt issuance failed for project endpoint ${details.domain}:`,
          error,
        );
      },
    );
  } catch {
    warnings.push(
      "The endpoint was activated, but automatic DNS and SSL planning could not complete. Review its Domains tab.",
    );
  }
  return { site, warnings };
}

export async function createLinkedServiceForActor(
  actor: PanelActor,
  requestedParentDomain: string,
  submitted: unknown,
  options: {
    serverIp: string;
    onAuthorized?: () => void;
    onPrepared?: (details: LinkedServicePreparedDetails) => void;
  },
) {
  const {
    site: parent,
    sites,
    client,
  } = await writableSiteForActor(actor, requestedParentDomain);
  const parentDomain = parent.domain.toLowerCase();
  options.onAuthorized?.();
  const input = createLinkedServiceSchema.parse(submitted);
  const baseDomain = await getBaseDomain();
  if (!baseDomain)
    throw new AppError(
      "INVALID_REQUEST",
      "No base domain is configured. Set one on the panel Settings page first.",
      409,
    );
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(options.serverIp))
    throw new AppError(
      "INVALID_REQUEST",
      "The server's public IPv4 address could not be detected. Set SERVER_PUBLIC_IP.",
      503,
    );

  const allMeta = await getAllSiteMeta();
  const parentMeta = assertParentMeta(allMeta[parentDomain]);
  const siblings = await getLinkedServiceMeta(parentDomain);
  if (
    Object.values(siblings).some(
      (meta) => meta.serviceName === input.serviceName,
    )
  )
    throw new AppError(
      "INVALID_REQUEST",
      `A project endpoint named "${input.serviceName}" already exists.`,
      409,
    );
  assertPortUnclaimed(input.targetPort, allMeta, sites);

  const externalPorts = sites
    .map((site) => site.appPort)
    .filter((port): port is number => typeof port === "number");
  const { id, category } = await allocateSiteId(
    parentMeta.category,
    externalPorts,
  );
  const domain = systemDomainFor(id, options.serverIp, baseDomain);
  const aliases = Array.from(
    new Set(input.aliases.filter((alias) => alias !== domain)),
  );
  const prepared = {
    parent: parentDomain,
    serviceName: input.serviceName,
    domain,
    siteId: id,
    targetPort: input.targetPort,
  };
  options.onPrepared?.(prepared);
  const meta: SiteMeta = {
    id,
    category: category.id,
    aliases,
    block: "none",
    parent: parentDomain,
    serviceName: input.serviceName,
    targetPort: input.targetPort,
  };
  const probe = await verifyPort(client, actor, parentDomain, input.targetPort);
  if (!probe.reachable) {
    if (!input.allowPending)
      throw new AppError("INVALID_REQUEST", probe.detail, 409);
    await setSiteMeta(domain, { ...meta, pending: true });
    return {
      endpoint: endpointView(domain, { ...meta, pending: true }, undefined, []),
      warnings: [
        `${probe.detail} The port is reserved as pending and is not publicly proxied. Verify it after the service starts.`,
      ],
      prepared,
      verification: probe,
    };
  }

  try {
    const activated = await activateEndpoint(
      actor,
      client,
      prepared,
      meta,
      options.serverIp,
    );
    return {
      endpoint: endpointView(
        domain,
        { ...meta, pending: false },
        activated.site,
        [{ port: input.targetPort, address: "127.0.0.1" }],
      ),
      site: activated.site,
      warnings: activated.warnings,
      prepared,
      verification: probe,
    };
  } catch (error) {
    await removeSiteMeta(domain).catch(() => undefined);
    throw error;
  }
}

async function endpointAccess(
  actor: PanelActor,
  requestedParentDomain: string,
  requestedEndpointDomain: string,
) {
  const {
    site: parent,
    sites,
    client,
  } = await writableSiteForActor(actor, requestedParentDomain);
  const parentDomain = parent.domain.toLowerCase();
  const endpointDomain = requestedEndpointDomain.toLowerCase();
  const meta = assertEndpointMeta(
    parentDomain,
    await getSiteMeta(endpointDomain),
  );
  const site = sites.find(
    (candidate) => candidate.domain.toLowerCase() === endpointDomain,
  );
  return { parentDomain, endpointDomain, meta, site, sites, client };
}

export async function verifyProjectEndpointForActor(
  actor: PanelActor,
  requestedParentDomain: string,
  requestedEndpointDomain: string,
  options: { serverIp: string },
) {
  const access = await endpointAccess(
    actor,
    requestedParentDomain,
    requestedEndpointDomain,
  );
  const targetPort = endpointPort(access.meta, access.site);
  if (!targetPort)
    throw new AppError(
      "INVALID_REQUEST",
      "The project endpoint has no valid target port.",
      409,
    );
  assertPortUnclaimed(
    targetPort,
    await getAllSiteMeta(),
    access.sites,
    access.endpointDomain,
  );
  const probe = await verifyPort(
    access.client,
    actor,
    access.parentDomain,
    targetPort,
    access.endpointDomain,
  );
  if (!probe.reachable)
    return {
      verified: false,
      activated: false,
      endpoint: endpointView(
        access.endpointDomain,
        access.meta,
        access.site,
        [],
      ),
      verification: probe,
      warnings: [],
    };
  if (access.site && !access.meta.pending)
    return {
      verified: true,
      activated: false,
      endpoint: endpointView(access.endpointDomain, access.meta, access.site, [
        { port: targetPort, address: "127.0.0.1" },
      ]),
      verification: probe,
      warnings: [],
    };

  const activated = await activateEndpoint(
    actor,
    access.client,
    {
      parent: access.parentDomain,
      serviceName: access.meta.serviceName ?? access.endpointDomain,
      domain: access.endpointDomain,
      siteId: access.meta.id,
      targetPort,
    },
    access.meta,
    options.serverIp,
  );
  return {
    verified: true,
    activated: true,
    endpoint: endpointView(
      access.endpointDomain,
      { ...access.meta, pending: false },
      activated.site,
      [{ port: targetPort, address: "127.0.0.1" }],
    ),
    verification: probe,
    warnings: activated.warnings,
  };
}

export async function updateProjectEndpointForActor(
  actor: PanelActor,
  requestedParentDomain: string,
  requestedEndpointDomain: string,
  submitted: unknown,
) {
  const input = updateProjectEndpointSchema.parse(submitted);
  const access = await endpointAccess(
    actor,
    requestedParentDomain,
    requestedEndpointDomain,
  );
  assertPortUnclaimed(
    input.targetPort,
    await getAllSiteMeta(),
    access.sites,
    access.endpointDomain,
  );
  if (!access.site || access.meta.pending) {
    const nextMeta = {
      ...access.meta,
      targetPort: input.targetPort,
      pending: true,
    };
    await setSiteMeta(access.endpointDomain, nextMeta);
    return {
      endpoint: endpointView(access.endpointDomain, nextMeta, undefined, []),
      pending: true,
    };
  }

  const probe = await verifyPort(
    access.client,
    actor,
    access.parentDomain,
    input.targetPort,
    access.endpointDomain,
  );
  if (!probe.reachable)
    throw new AppError("INVALID_REQUEST", probe.detail, 409);
  const previousUrl = access.site.reverseProxyUrl;
  if (!previousUrl)
    throw new AppError(
      "INVALID_REQUEST",
      "The existing reverse-proxy target is unavailable for rollback.",
      409,
    );
  let site: CloudPanelSite;
  try {
    site = await access.client.updateSite(
      actor.cloudPanel,
      access.endpointDomain,
      {
        reverseProxyUrl: `http://127.0.0.1:${input.targetPort}`,
        endpointParentDomain: access.parentDomain,
      },
    );
    const postSwap = await verifyPort(
      access.client,
      actor,
      access.parentDomain,
      input.targetPort,
      access.endpointDomain,
    );
    if (!postSwap.reachable) throw new Error(postSwap.detail);
    await setSiteMeta(access.endpointDomain, {
      ...access.meta,
      targetPort: input.targetPort,
      pending: false,
    });
  } catch (error) {
    const restored = await access.client
      .updateSite(actor.cloudPanel, access.endpointDomain, {
        reverseProxyUrl: previousUrl,
        endpointParentDomain: access.parentDomain,
      })
      .then(() => true)
      .catch(() => false);
    throw new AppError(
      "SITE_UPDATE_FAILED",
      `${
        restored
          ? "The new endpoint failed its health gate and the previous proxy was restored."
          : "The new endpoint failed its health gate, and Panelavo could not restore the previous proxy automatically. Restore it from the parent project's endpoint controls before retrying."
      } ${error instanceof Error ? error.message : ""}`.trim(),
      502,
    );
  }
  return {
    endpoint: endpointView(
      access.endpointDomain,
      { ...access.meta, targetPort: input.targetPort, pending: false },
      site,
      [{ port: input.targetPort, address: "127.0.0.1" }],
    ),
    pending: false,
    verification: probe,
  };
}

export async function deleteProjectEndpointForActor(
  actor: PanelActor,
  requestedParentDomain: string,
  requestedEndpointDomain: string,
) {
  const access = await endpointAccess(
    actor,
    requestedParentDomain,
    requestedEndpointDomain,
  );
  if (access.site) await deleteManagedSite(actor, access.endpointDomain);
  else await removeSiteMeta(access.endpointDomain);
  return { deleted: true, domain: access.endpointDomain };
}
