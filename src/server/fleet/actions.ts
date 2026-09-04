import { readFile } from "node:fs/promises";
import { join } from "node:path";
import QRCode from "qrcode";
import { z } from "zod";
import { cloudRoleFor, setPanelAdmin } from "@/server/auth/panel-roles";
import { revokeAllMcpConnections } from "@/server/mcp/oauth";
import { createSiteSchema, updateSiteSchema } from "@/schemas/sites";
import type { PanelActor } from "@/server/auth/site-access";
import type { PanelRole } from "@/types/cloudpanel";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import type { FleetActionName, FleetServerSummary } from "@/server/fleet/types";
import { getServerPublicIp } from "@/server/network/server-ip";
import { readAuditEvents } from "@/server/security/log";
import {
  createLinkedServiceForActor,
  deleteProjectEndpointForActor,
  listLinkedServicesForActor,
  updateProjectEndpointForActor,
  verifyProjectEndpointForActor,
} from "@/server/sites/linked-service-service";
import {
  getSiteBackupAutomationForActor,
  getSiteDeployHooksForActor,
  getSiteUptimeForActor,
  manageSiteOffsiteBackupForActor,
  removeSiteOffsiteDestinationForActor,
  saveSiteBackupScheduleForActor,
  saveSiteDeployHooksForActor,
  saveSiteOffsiteDestinationForActor,
  saveSiteUptimeForActor,
} from "@/server/sites/site-automation-service";
import {
  getSiteDnsForActor,
  getSiteDomainsForActor,
  manageSiteDomainsForActor,
  pointSiteDnsForActor,
} from "@/server/sites/site-domain-service";
import {
  getSiteSectionForActor,
  manageSiteSectionForActor,
} from "@/server/sites/site-section-service";
import {
  createManagedSite,
  deleteManagedSite,
  getManagedSite,
  getSiteCreationDetails,
  listManagedSites,
  updateManagedSite,
} from "@/server/sites/site-service";
import { getResourceHistory } from "@/server/system/resource-history";
import { getServerResourceSnapshot } from "@/server/system/resource-snapshot";
import { getUpdateState, queueUpdate } from "@/server/updates/panel-updater";
import { vpnManageSchema } from "@/server/vpn/schema";

const objectInput = z.record(z.unknown()).default({});
const domainInput = z
  .object({ domain: z.string().min(1).max(253) })
  .passthrough();
const sectionInput = domainInput
  .extend({ section: z.string().min(1).max(40) })
  .passthrough();
const auditInput = z
  .object({
    page: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().max(100).optional(),
    action: z.string().max(100).optional(),
    result: z.enum(["success", "failure"]).optional(),
    actor: z.string().max(100).optional(),
    target: z.string().max(253).optional(),
    search: z.string().max(200).optional(),
    from: z.string().max(40).optional(),
    to: z.string().max(40).optional(),
  })
  .strict();

async function packageMetadata() {
  const value = JSON.parse(
    await readFile(join(process.cwd(), "package.json"), "utf8"),
  ) as {
    version?: string;
    panelavo?: {
      brokerProtocolVersion?: number;
      fleetProtocolVersion?: number;
    };
  };
  return {
    panelVersion: String(value.version ?? "unknown"),
    brokerProtocolVersion: Number(value.panelavo?.brokerProtocolVersion ?? 0),
    fleetProtocolVersion: Number(value.panelavo?.fleetProtocolVersion ?? 0),
  };
}

export async function executeFleetAction(
  actor: PanelActor,
  action: FleetActionName,
  submitted?: unknown,
): Promise<unknown> {
  if (actor.user.panelRole !== "super-admin")
    throw new AppError(
      "FORBIDDEN",
      "Fleet actions require an active Super Admin.",
      403,
    );
  const client = getCloudPanelClient();
  const serverIp = await getServerPublicIp();
  if (action === "system.summary") {
    const [server, resources, sites, update, metadata] = await Promise.all([
      client.getServerInfo(actor.cloudPanel),
      getServerResourceSnapshot(actor.cloudPanel),
      listManagedSites(actor),
      getUpdateState(false),
      packageMetadata(),
    ]);
    return {
      nodeId: "local",
      label: server.hostname,
      origin: "local",
      ...metadata,
      server,
      resources,
      sites,
      update,
    } satisfies FleetServerSummary;
  }
  if (action === "system.resources")
    return {
      resources: await getServerResourceSnapshot(actor.cloudPanel),
      history: await getResourceHistory(),
    };
  if (action === "system.storage")
    return { storage: await client.getServerStorage(actor.cloudPanel, false) };
  if (action === "system.storage.refresh")
    return { storage: await client.getServerStorage(actor.cloudPanel, true) };
  if (action === "system.storage.reclaim") {
    const input = objectInput.parse(submitted);
    if (input.confirmation !== "RECLAIM BUILD CACHE")
      throw new AppError(
        "INVALID_REQUEST",
        "The storage cleanup confirmation was invalid.",
        400,
      );
    return { cleanup: await client.reclaimServerStorage(actor.cloudPanel) };
  }
  if (action === "system.info") return client.getServerInfo(actor.cloudPanel);
  if (action === "system.update.get")
    return getUpdateState(Boolean(objectInput.parse(submitted).check));
  if (action === "system.update.start") {
    const input = objectInput.parse(submitted);
    if (input.confirmation !== "UPDATE PANELAVO")
      throw new AppError(
        "INVALID_REQUEST",
        "The Panelavo update confirmation was invalid.",
        400,
      );
    return queueUpdate();
  }
  if (action === "sites.list") return { sites: await listManagedSites(actor) };
  if (action === "sites.creation-details") return getSiteCreationDetails(actor);
  if (action === "sites.create")
    return createManagedSite(actor, createSiteSchema.parse(submitted), {
      serverIp,
    });
  if (action === "site.get")
    return getManagedSite(actor, domainInput.parse(submitted).domain);
  if (action === "site.update") {
    const input = domainInput.parse(submitted);
    return updateManagedSite(
      actor,
      input.domain,
      updateSiteSchema.parse(input.data),
    );
  }
  if (action === "site.delete") {
    const input = domainInput.parse(submitted);
    if (input.confirmation !== input.domain)
      throw new AppError(
        "INVALID_REQUEST",
        "Type the exact website domain to delete it.",
        400,
      );
    return deleteManagedSite(actor, input.domain, { serverIp });
  }
  if (action === "site.section.get") {
    const input = sectionInput.parse(submitted);
    return getSiteSectionForActor(actor, input.domain, input.section);
  }
  if (action === "site.section.manage") {
    const input = sectionInput.parse(submitted);
    const sectionAction =
      input.data && typeof input.data === "object" && "action" in input.data
        ? String((input.data as { action?: unknown }).action ?? "")
        : "";
    if (
      input.section === "databases" &&
      (sectionAction === "manage-login" ||
        sectionAction.startsWith("exposure-"))
    )
      throw new AppError(
        "FORBIDDEN",
        "Database exposure credentials and one-time phpMyAdmin access remain local to the Node.",
        403,
      );
    return manageSiteSectionForActor(
      actor,
      input.domain,
      input.section,
      input.data,
    );
  }
  if (action === "site.domains.get") {
    const input = domainInput.parse(submitted);
    return getSiteDomainsForActor(actor, input.domain, serverIp);
  }
  if (action === "site.domains.manage") {
    const input = domainInput.parse(submitted);
    return manageSiteDomainsForActor(actor, input.domain, input.data, serverIp);
  }
  if (action === "site.dns.get") {
    const input = domainInput.parse(submitted);
    return getSiteDnsForActor(actor, input.domain, serverIp);
  }
  if (action === "site.dns.manage") {
    const input = domainInput.parse(submitted);
    return pointSiteDnsForActor(actor, input.domain, input.data, serverIp);
  }
  if (action === "site.uptime.get")
    return getSiteUptimeForActor(actor, domainInput.parse(submitted).domain);
  if (action === "site.uptime.save") {
    const input = domainInput.parse(submitted);
    return saveSiteUptimeForActor(actor, input.domain, input.data);
  }
  if (action === "site.deploy-hooks.get")
    return getSiteDeployHooksForActor(
      actor,
      domainInput.parse(submitted).domain,
    );
  if (action === "site.deploy-hooks.save") {
    const input = domainInput.parse(submitted);
    return saveSiteDeployHooksForActor(actor, input.domain, input.hooks);
  }
  if (action === "site.services.list")
    return listLinkedServicesForActor(
      actor,
      domainInput.parse(submitted).domain,
    );
  if (action === "site.services.create") {
    const input = domainInput.parse(submitted);
    return createLinkedServiceForActor(actor, input.domain, input.data, {
      serverIp,
    });
  }
  if (action === "site.service.verify") {
    const input = domainInput.parse(submitted);
    return verifyProjectEndpointForActor(
      actor,
      input.domain,
      String(input.serviceDomain),
      { serverIp },
    );
  }
  if (action === "site.service.update") {
    const input = domainInput.parse(submitted);
    return updateProjectEndpointForActor(
      actor,
      input.domain,
      String(input.serviceDomain),
      input.data,
    );
  }
  if (action === "site.service.delete") {
    const input = domainInput.parse(submitted);
    if (input.confirmation !== input.serviceDomain)
      throw new AppError(
        "INVALID_REQUEST",
        "Type the exact endpoint domain to delete it.",
        400,
      );
    return deleteProjectEndpointForActor(
      actor,
      input.domain,
      String(input.serviceDomain),
    );
  }
  if (action === "site.backup-automation.get")
    return getSiteBackupAutomationForActor(
      actor,
      domainInput.parse(submitted).domain,
    );
  if (action === "site.backup-schedule.save") {
    const input = domainInput.parse(submitted);
    return saveSiteBackupScheduleForActor(actor, input.domain, input.data);
  }
  if (action === "site.offsite.save") {
    const input = domainInput.parse(submitted);
    const result = await saveSiteOffsiteDestinationForActor(
      actor,
      input.domain,
      input.data,
    );
    return { destination: result.destination, items: result.offsiteBackups };
  }
  if (action === "site.offsite.manage") {
    const input = domainInput.parse(submitted);
    const operation = z
      .enum(["upload", "restore", "delete"])
      .parse(input.operation);
    const result = await manageSiteOffsiteBackupForActor(
      actor,
      input.domain,
      operation,
      String(input.id),
    );
    return { items: result.offsiteBackups };
  }
  if (action === "site.offsite.remove")
    return removeSiteOffsiteDestinationForActor(
      actor,
      domainInput.parse(submitted).domain,
    );
  if (action === "users.list")
    return {
      users: await client.listUsers(actor.cloudPanel),
      sites: (await client.listSites(actor.cloudPanel)).map(
        (site) => site.domain,
      ),
    };
  if (action === "users.manage") {
    const input = objectInput.parse(submitted);
    const userAction = String(input.action ?? "");
    if (userAction === "invite")
      throw new AppError(
        "FORBIDDEN",
        "Invitations can only be created from the Node itself.",
        403,
      );
    if (
      String(input.username ?? "").toLowerCase() ===
      actor.user.username.toLowerCase()
    )
      throw new AppError(
        "FORBIDDEN",
        "The Fleet connection owner can only be changed from that Node.",
        403,
      );
    const username = String(input.username ?? "").toLowerCase();
    const roles: PanelRole[] = ["super-admin", "manager", "admin", "user"];
    let panelRole: PanelRole | undefined;
    if (userAction === "add" || userAction === "update") {
      panelRole = roles.find((role) => role === String(input.role ?? ""));
      if (!panelRole)
        throw new AppError("INVALID_REQUEST", "Unknown role.", 400);
      input.role = cloudRoleFor(panelRole);
    }
    const target = ["reset-password", "delete"].includes(userAction)
      ? (await client.listUsers(actor.cloudPanel)).find(
          (user) => user.username.toLowerCase() === username,
        )
      : undefined;
    await client.manageUser(actor.cloudPanel, input);
    if (panelRole) await setPanelAdmin(username, panelRole === "admin");
    if (userAction === "delete") await setPanelAdmin(username, false);
    if (target) await revokeAllMcpConnections(target.id, target.username);
    return {};
  }
  if (action === "vpn.get") return client.getVpnState(actor.cloudPanel);
  if (action === "vpn.manage") {
    const result = await client.manageVpn(
      actor.cloudPanel,
      vpnManageSchema.parse(submitted),
    );
    if (result.provisioning)
      result.provisioning.qrCode = await QRCode.toDataURL(
        result.provisioning.configuration,
        { margin: 1, width: 280, errorCorrectionLevel: "M" },
      ).catch(() => undefined);
    return result;
  }
  if (action === "audit.list")
    return readAuditEvents(auditInput.parse(submitted ?? {}));
  throw new AppError(
    "INVALID_REQUEST",
    "That Fleet action is not available.",
    400,
  );
}
