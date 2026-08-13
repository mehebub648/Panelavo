import { randomInt } from "node:crypto";
import { createLinkedServiceSchema } from "@/schemas/sites";
import type { PanelActor } from "@/server/auth/site-access";
import {
  accessibleSiteForActor,
  writableSiteForActor,
} from "@/server/auth/site-access";
import { AppError } from "@/server/cloudpanel/errors";
import { getBaseDomain } from "@/server/settings/store";
import { issueSiteSsl, planSiteSsl } from "@/server/sites/ensure-ssl";
import {
  allocateSiteId,
  getAllSiteMeta,
  getLinkedServiceMeta,
  removeSiteMeta,
  setSiteMeta,
  siteUserForId,
  systemDomainFor,
} from "@/server/sites/site-meta";

function makeSiteUserPassword() {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%+=_-";
  return Array.from({ length: 24 }, () => chars[randomInt(chars.length)]).join(
    "",
  );
}

export async function listLinkedServicesForActor(
  actor: PanelActor,
  requestedParentDomain: string,
) {
  const { site: parent, sites } = await accessibleSiteForActor(
    actor,
    requestedParentDomain,
  );
  const parentDomain = parent.domain.toLowerCase();
  const children = await getLinkedServiceMeta(parentDomain);
  const services = Object.entries(children).map(([domain, meta]) => {
    const site = sites.find(
      (candidate) => candidate.domain.toLowerCase() === domain,
    );
    return {
      domain,
      serviceName: meta.serviceName ?? domain,
      aliases: meta.aliases,
      reverseProxyUrl: site?.reverseProxyUrl,
      status: site?.status,
      accessible: Boolean(site),
    };
  });
  return { services };
}

export type LinkedServicePreparedDetails = {
  parent: string;
  serviceName: string;
  domain: string;
  siteId: number;
  targetPort: number;
};

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
  const { serverIp } = options;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(serverIp))
    throw new AppError(
      "INVALID_REQUEST",
      "The server's public IPv4 address could not be detected. Set SERVER_PUBLIC_IP.",
      503,
    );

  const allMeta = await getAllSiteMeta();
  const parentMeta = allMeta[parentDomain];
  if (!parentMeta)
    throw new AppError(
      "INVALID_REQUEST",
      "Linked services are only available for panel-created websites.",
      409,
    );
  if (parentMeta.parent)
    throw new AppError(
      "INVALID_REQUEST",
      "A linked service cannot have services of its own. Add it to the parent website instead.",
      400,
    );
  const siblings = await getLinkedServiceMeta(parentDomain);
  if (
    Object.values(siblings).some(
      (meta) => meta.serviceName === input.serviceName,
    )
  )
    throw new AppError(
      "INVALID_REQUEST",
      `A linked service named "${input.serviceName}" already exists for this website.`,
      409,
    );

  const externalPorts = sites
    .map((site) => site.appPort)
    .filter((port): port is number => typeof port === "number");
  const foreignPorts = new Set([
    ...Object.entries(allMeta)
      .filter(([domain]) => domain !== parentDomain)
      .map(([, meta]) => meta.id),
    ...sites
      .filter((site) => site.domain.toLowerCase() !== parentDomain)
      .map((site) => site.appPort)
      .filter((port): port is number => typeof port === "number"),
  ]);
  if (foreignPorts.has(input.targetPort))
    throw new AppError(
      "INVALID_REQUEST",
      `Port ${input.targetPort} is reserved by another website. Point the service at a port this website's own stack exposes.`,
      409,
    );

  const { id, category } = await allocateSiteId(
    parentMeta.category,
    externalPorts,
  );
  const domain = systemDomainFor(id, serverIp, baseDomain);
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

  const site = await client.createSite(actor.cloudPanel, {
    type: "reverse-proxy",
    domain,
    siteUser: siteUserForId(id),
    siteUserPassword: makeSiteUserPassword(),
    reverseProxyUrl: `http://127.0.0.1:${input.targetPort}`,
  });
  const warnings: string[] = [];
  const meta = {
    id,
    category: category.id,
    aliases,
    block: "none" as const,
    parent: parentDomain,
    serviceName: input.serviceName,
  };
  try {
    if (actor.user.panelRole === "admin")
      await client.assignSite(actor.cloudPanel, domain);
    await setSiteMeta(domain, meta);
  } catch (error) {
    await client.deleteSite(actor.cloudPanel, domain).catch(() => undefined);
    await removeSiteMeta(domain).catch(() => undefined);
    throw error;
  }

  if (aliases.length) {
    try {
      await client.manageSiteSection(actor.cloudPanel, domain, "domains", {
        action: "sync",
        systemDomain: domain,
        aliases,
        block: "none",
      });
    } catch {
      warnings.push(
        "The service was created, but failed to configure its domain aliases. Try saving them again from the service's Settings tab.",
      );
    }
  }

  const plan = await planSiteSsl({
    userId: actor.user.id,
    systemDomain: domain,
    aliases,
    serverIp,
    autoPoint: true,
  });
  warnings.push(...plan.warnings);
  void issueSiteSsl(actor.cloudPanel, domain, plan.san).catch(
    (error: unknown) => {
      console.error(
        `Let's Encrypt issuance failed for linked service ${domain}:`,
        error,
      );
    },
  );

  return { site: { ...site, meta }, warnings, prepared };
}
