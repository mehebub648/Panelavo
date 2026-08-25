import type { PanelActor } from "@/server/auth/site-access";
import { writableSiteForActor } from "@/server/auth/site-access";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { getAllUptimeStates, removeUptime } from "@/server/monitoring/store";
import { autoDeleteDns } from "@/server/network/auto-dns";
import { getServerPublicIp } from "@/server/network/server-ip";
import { getBaseDomain } from "@/server/settings/store";
import { removeBackupSchedule } from "@/server/backups/schedule";
import { removeOffsiteDestination } from "@/server/backups/offsite";
import { secureCreatedSite } from "@/server/sites/initial-site-ssl";
import {
  getLabelsForSites,
  getSiteLabel,
  removeSiteLabel,
  setSiteLabel,
} from "@/server/sites/site-labels";
import {
  allocateSiteId,
  getAllSiteMeta,
  getLinkedServiceMeta,
  getSiteMeta,
  nextFreeId,
  removeSiteMeta,
  setSiteMeta,
  siteUserForId,
  SITE_CATEGORIES,
  systemDomainFor,
} from "@/server/sites/site-meta";
import {
  getSiteRootOverride,
  removeSiteRootOverride,
  setSiteRootOverride,
} from "@/server/sites/site-root-overlay";
import {
  localSiteProxyUrl,
  managedApplicationPort,
  managedSiteIdForApplicationPort,
} from "@/lib/site-url";
import type { ValidCreateSiteInput } from "@/schemas/sites";
import type { z } from "zod";
import { updateSiteSchema } from "@/schemas/sites";
import type { CreateSiteInput } from "@/types/cloudpanel";

export type ValidUpdateSiteInput = z.infer<typeof updateSiteSchema>;

function assertCreateAccess(actor: PanelActor) {
  if (!actor.user.canCreateSites)
    throw new AppError(
      "FORBIDDEN",
      "You do not have permission to create websites.",
      403,
    );
}

export async function listManagedSites(actor: PanelActor) {
  const sites = await getCloudPanelClient().listSites(actor.cloudPanel);
  const [meta, uptime, labels] = await Promise.all([
    getAllSiteMeta(),
    getAllUptimeStates(),
    getLabelsForSites(sites),
  ]);
  return sites.map((site) => {
    const siteMeta = meta[site.domain.toLowerCase()];
    const categoryIndex = SITE_CATEGORIES.findIndex(
      (item) => item.id === siteMeta?.category,
    );
    const category =
      categoryIndex >= 0 ? SITE_CATEGORIES[categoryIndex] : undefined;
    return {
      ...site,
      label: labels[site.domain.toLowerCase()],
      category: category?.id ?? "uncategorized",
      categoryLabel: category?.label ?? "Uncategorized",
      categoryOrder:
        categoryIndex >= 0 ? categoryIndex : SITE_CATEGORIES.length,
      ...(siteMeta ? { meta: siteMeta } : {}),
      uptime: uptime[site.domain.toLowerCase()],
    };
  });
}

export async function getManagedSite(actor: PanelActor, domain: string) {
  const normalized = domain.toLowerCase();
  const site = (await listManagedSites(actor)).find(
    (candidate) => candidate.domain.toLowerCase() === normalized,
  );
  if (!site) throw new AppError("SITE_NOT_FOUND", "Website not found.", 404);
  return {
    ...site,
    applicationRootDirectory:
      (await getSiteRootOverride(site.domain)) ?? site.rootDirectory,
  };
}

export async function getSiteCreationDetails(actor: PanelActor) {
  assertCreateAccess(actor);
  const client = getCloudPanelClient();
  const [options, baseDomain, serverIp, meta, sites] = await Promise.all([
    client.getSiteCreationOptions(actor.cloudPanel),
    getBaseDomain(),
    getServerPublicIp(),
    getAllSiteMeta(),
    client.listSites(actor.cloudPanel).catch(() => []),
  ]);
  const reserved = [
    ...Object.values(meta).map((item) => item.id),
    ...[
      ...sites
        .map((site) => site.appPort)
        .filter((port): port is number => typeof port === "number"),
      ...options.reservedPorts,
    ].flatMap((port) => {
      const siteId = managedSiteIdForApplicationPort(port);
      return siteId === null ? [] : [siteId];
    }),
  ];
  return {
    options,
    baseDomain,
    serverIp,
    categories: SITE_CATEGORIES.map((category) => ({
      ...category,
      nextId: nextFreeId(category, reserved),
    })),
  };
}

export async function createManagedSite(
  actor: PanelActor,
  input: ValidCreateSiteInput,
  options: { serverIp?: string } = {},
) {
  assertCreateAccess(actor);
  const baseDomain = await getBaseDomain();
  if (!baseDomain)
    throw new AppError(
      "INVALID_REQUEST",
      "No base domain is configured. Set one on the panel Settings page first.",
      409,
    );
  const serverIp = options.serverIp || (await getServerPublicIp());
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(serverIp))
    throw new AppError(
      "INVALID_REQUEST",
      "The server's public IPv4 address could not be detected. Set SERVER_PUBLIC_IP.",
      503,
    );

  const client = getCloudPanelClient();
  const [existingSites, creationOptions] = await Promise.all([
    client.listSites(actor.cloudPanel),
    client.getSiteCreationOptions(actor.cloudPanel),
  ]);
  const reservedIds = [
    ...existingSites
      .map((site) => site.appPort)
      .filter((port): port is number => typeof port === "number"),
    ...creationOptions.reservedPorts,
  ].flatMap((port) => {
    const siteId = managedSiteIdForApplicationPort(port);
    return siteId === null ? [] : [siteId];
  });
  const { id, category } = await allocateSiteId(input.category, reservedIds);
  const appPort = managedApplicationPort(id)!;
  const domain = systemDomainFor(id, serverIp, baseDomain);
  const siteUser = siteUserForId(id);
  const aliases = Array.from(
    new Set(input.aliases.filter((alias) => alias !== domain)),
  );
  const shared = {
    domain,
    siteUser,
    siteUserPassword: input.siteUserPassword,
  };
  const createInput: CreateSiteInput =
    input.type === "php"
      ? {
          type: "php",
          ...shared,
          phpVersion: input.phpVersion,
          vhostTemplate: input.vhostTemplate,
        }
      : input.type === "nodejs"
        ? {
            type: "nodejs",
            ...shared,
            nodeVersion: input.nodeVersion,
            appPort,
          }
        : input.type === "python"
          ? {
              type: "python",
              ...shared,
              pythonVersion: input.pythonVersion,
              appPort,
            }
          : input.type === "reverse-proxy"
            ? {
                type: "reverse-proxy",
                ...shared,
                reverseProxyUrl: input.reverseProxyUrl || localSiteProxyUrl(id),
              }
            : input.type === "docker"
              ? { type: "docker", ...shared, appPort }
              : { type: "static", ...shared };

  const site = await client.createSite(actor.cloudPanel, createInput);
  const warnings: string[] = [];
  try {
    if (actor.user.panelRole === "admin")
      await client.assignSite(actor.cloudPanel, domain);
    await setSiteMeta(domain, {
      id,
      category: category.id,
      aliases,
      block: "none",
    });
    await setSiteLabel(domain, site.id, input.label ?? "");
  } catch (error) {
    await client.deleteSite(actor.cloudPanel, domain).catch(() => undefined);
    await removeSiteMeta(domain).catch(() => undefined);
    await removeSiteLabel(domain).catch(() => undefined);
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
        "Website was created, but failed to configure your domain aliases. Try saving them again from the Settings tab.",
      );
    }
  }
  warnings.push(
    ...(await secureCreatedSite(actor.cloudPanel, {
      userId: actor.user.id,
      systemDomain: domain,
      aliases,
      serverIp,
    })),
  );

  return {
    site: {
      ...site,
      label: input.label || undefined,
      category: category.id,
      categoryLabel: category.label,
      categoryOrder: SITE_CATEGORIES.findIndex(
        (item) => item.id === category.id,
      ),
      meta: { id, category: category.id, aliases, block: "none" },
    },
    warnings,
  };
}

export async function updateManagedSite(
  actor: PanelActor,
  domain: string,
  input: ValidUpdateSiteInput,
) {
  const { client, site: accessibleSite } = await writableSiteForActor(
    actor,
    domain,
  );
  const {
    applicationRootDirectory,
    servingDirectory,
    rootDirectory: legacyServingDirectory,
    label,
    ...otherSettings
  } = input;
  const meta = await getSiteMeta(domain);
  if (meta?.parent && input.reverseProxyUrl !== undefined)
    throw new AppError(
      "INVALID_REQUEST",
      "Change a project endpoint through the parent project's endpoint controls so ownership, health checks, and rollback remain enforced.",
      409,
    );
  const upstreamSettings = {
    ...otherSettings,
    applicationRootDirectory,
    rootDirectory: servingDirectory ?? legacyServingDirectory,
  };
  const site = Object.values(upstreamSettings).some(
    (value) => value !== undefined,
  )
    ? await client.updateSite(actor.cloudPanel, domain, upstreamSettings)
    : accessibleSite;
  if (applicationRootDirectory !== undefined)
    await setSiteRootOverride(domain, applicationRootDirectory);
  if (label !== undefined) await setSiteLabel(domain, site.id, label);
  return {
    site: {
      ...site,
      label:
        label !== undefined
          ? label || undefined
          : await getSiteLabel(domain, site.id),
      applicationRootDirectory:
        applicationRootDirectory ??
        (await getSiteRootOverride(domain)) ??
        site.rootDirectory,
    },
    meta: await getSiteMeta(domain),
  };
}

export async function deleteManagedSite(
  actor: PanelActor,
  domain: string,
  options: { serverIp?: string } = {},
) {
  const { client } = await writableSiteForActor(actor, domain);
  const meta = await getSiteMeta(domain);
  const services = await getLinkedServiceMeta(domain);
  const serviceNames = Object.values(services).map(
    (service) => service.serviceName ?? "service",
  );
  if (serviceNames.length)
    throw new AppError(
      "INVALID_REQUEST",
      `This website still has project endpoints (${serviceNames.join(", ")}). Delete them first.`,
      409,
    );

  await client.deleteSite(actor.cloudPanel, domain);
  await Promise.all([
    removeSiteMeta(domain).catch(() => undefined),
    removeSiteRootOverride(domain).catch(() => undefined),
    removeBackupSchedule(domain).catch(() => undefined),
    removeOffsiteDestination(domain).catch(() => undefined),
    removeUptime(domain).catch(() => undefined),
    removeSiteLabel(domain).catch(() => undefined),
  ]);

  void (async () => {
    try {
      const serverIp = options.serverIp || (await getServerPublicIp());
      await autoDeleteDns(actor.user.id, domain, serverIp);
      for (const alias of meta?.aliases ?? [])
        await autoDeleteDns(actor.user.id, alias, serverIp);
    } catch (error: unknown) {
      console.error("Auto DNS delete failed on site removal:", error);
    }
  })();
  return { deleted: true };
}
