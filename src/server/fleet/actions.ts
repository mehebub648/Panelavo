import { getFleetHealthReport } from "@/server/fleet/health";
import { createUserInvitation } from "@/server/auth/user-invitation";
import { changePanelAddress } from "@/server/fleet/address";
import {
  listServerConnections,
  manageServerConnections,
} from "@/server/fleet/connections";
import { getPanelAddressState } from "@/server/settings/panel-address-store";
import { parseFleetOrigin } from "@/server/fleet/network";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import QRCode from "qrcode";
import { z } from "zod";
import {
  addCredential,
  deleteCredential,
  getRecords,
  getZones,
  listCredentials,
  mutateRecord,
} from "@/server/cloudflare/store";
import { revokeFleetAuthorizations } from "@/server/fleet/store";
import { cloudRoleFor, setPanelAdmin } from "@/server/auth/panel-roles";
import {
  createMcpPersonalToken,
  listMcpConnections,
  revokeAllMcpConnections,
  revokeMcpConnection,
} from "@/server/mcp/oauth";
import type { McpPublicUrls } from "@/server/mcp/public-url";
import { getPanelPublicDomain } from "@/server/sites/panel-self";
import { createSiteSchema, updateSiteSchema } from "@/schemas/sites";
import type { PanelActor } from "@/server/auth/site-access";
import type { PanelRole } from "@/types/cloudpanel";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import type { FleetActionName, FleetServerSummary } from "@/server/fleet/types";
import { getServerPublicIp } from "@/server/network/server-ip";
import { completeServerInformation } from "@/server/network/server-information";
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
import {
  getUpdateState,
  queueUpdate,
  validateUpdateRepository,
} from "@/server/updates/panel-updater";
import { vpnManageSchema } from "@/server/vpn/schema";
import {
  getPublicNotificationSettings,
  notificationSettingsSchema,
  saveNotificationSettings,
} from "@/server/notifications/store";
import { sendNotification } from "@/server/notifications/send";
import {
  getMonitoringSettings,
  monitoringSettingsSchema,
  saveMonitoringSettings,
} from "@/server/monitoring/store";
import {
  getSecuritySettings,
  setSecuritySettings,
  setUpdateRepository,
} from "@/server/settings/store";

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
const cloudflareId = z.string().trim().min(1).max(128);
const cloudflareRecordInput = z
  .object({
    credentialId: cloudflareId,
    zoneId: cloudflareId,
    action: z.enum(["create", "update", "delete"]),
    id: cloudflareId.optional(),
    record: z.record(z.unknown()).optional(),
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

function localMcpUrls(): McpPublicUrls {
  const domain = getPanelPublicDomain();
  if (!domain)
    throw new AppError(
      "INTERNAL_ERROR",
      "The selected server has no public panel address.",
      503,
    );
  const origin = `https://${domain}`;
  return {
    origin,
    issuer: origin,
    resource: `${origin}/mcp`,
    authorizationEndpoint: `${origin}/oauth/authorize`,
    tokenEndpoint: `${origin}/oauth/token`,
    registrationEndpoint: `${origin}/oauth/register`,
    revocationEndpoint: `${origin}/oauth/revoke`,
    resourceMetadataEndpoint: `${origin}/.well-known/oauth-protected-resource/mcp`,
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
  if (
    action === "system.summary" &&
    objectInput.parse(submitted).healthOnly === true
  )
    return getFleetHealthReport();
  const client = getCloudPanelClient();
  if (action === "system.about")
    return {
      ...(await packageMetadata()),
      server: await client.getServerInfo(actor.cloudPanel),
    };
  if (action === "panel.address.get")
    return {
      origin: localMcpUrls().origin,
      pendingOrigin: getPanelAddressState().pending?.origin,
    };
  if (action === "panel.address.change") {
    const input = z
      .object({
        origin: z.string().max(300).transform(parseFleetOrigin),
        confirmation: z.string().max(253),
      })
      .strict()
      .refine(
        (value) => value.confirmation === new URL(value.origin).hostname,
        "Type the new hostname exactly to confirm.",
      )
      .parse(submitted);
    return changePanelAddress(input.origin, localMcpUrls().origin, actor);
  }
  if (action === "panel.connections.list") return listServerConnections();
  if (action === "panel.connections.manage")
    return manageServerConnections(actor, submitted, localMcpUrls().origin);
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
  if (action === "system.info")
    return completeServerInformation(
      await client.getServerInfo(actor.cloudPanel),
      localMcpUrls().origin,
    );
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
      serverIp: await getServerPublicIp(),
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
    return deleteManagedSite(actor, input.domain, {
      serverIp: await getServerPublicIp(),
    });
  }
  if (action === "site.section.get") {
    const input = sectionInput.parse(submitted);
    return getSiteSectionForActor(actor, input.domain, input.section);
  }
  if (action === "site.section.manage") {
    const input = sectionInput.parse(submitted);
    return manageSiteSectionForActor(
      actor,
      input.domain,
      input.section,
      input.data,
    );
  }
  if (action === "site.domains.get") {
    const input = domainInput.parse(submitted);
    return getSiteDomainsForActor(
      actor,
      input.domain,
      await getServerPublicIp(),
    );
  }
  if (action === "site.domains.manage") {
    const input = domainInput.parse(submitted);
    return manageSiteDomainsForActor(
      actor,
      input.domain,
      input.data,
      await getServerPublicIp(),
    );
  }
  if (action === "site.dns.get") {
    const input = domainInput.parse(submitted);
    return getSiteDnsForActor(actor, input.domain, await getServerPublicIp());
  }
  if (action === "site.dns.manage") {
    const input = domainInput.parse(submitted);
    return pointSiteDnsForActor(
      actor,
      input.domain,
      input.data,
      await getServerPublicIp(),
    );
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
      serverIp: await getServerPublicIp(),
    });
  }
  if (action === "site.service.verify") {
    const input = domainInput.parse(submitted);
    return verifyProjectEndpointForActor(
      actor,
      input.domain,
      String(input.serviceDomain),
      { serverIp: await getServerPublicIp() },
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
  if (action === "cloudflare.credentials.list")
    return { credentials: await listCredentials(actor.user.id) };
  if (action === "cloudflare.credentials.add") {
    const input = z
      .object({
        label: z.string().trim().min(1).max(80),
        token: z.string().trim().min(20).max(4096),
      })
      .strict()
      .parse(submitted);
    return {
      credential: await addCredential(actor.user.id, input.label, input.token),
    };
  }
  if (action === "cloudflare.credentials.delete") {
    const input = z.object({ id: z.string().uuid() }).strict().parse(submitted);
    await deleteCredential(actor.user.id, input.id);
    return {};
  }
  if (action === "cloudflare.zones.list") {
    const input = z
      .object({ refresh: z.boolean().optional() })
      .strict()
      .parse(submitted ?? {});
    return getZones(actor.user.id, input.refresh === true);
  }
  if (action === "cloudflare.records.list") {
    const input = z
      .object({ credentialId: cloudflareId, zoneId: cloudflareId })
      .strict()
      .parse(submitted);
    return {
      records: await getRecords(
        actor.user.id,
        input.credentialId,
        input.zoneId,
      ),
    };
  }
  if (action === "cloudflare.records.manage") {
    const input = cloudflareRecordInput.parse(submitted);
    return {
      record: await mutateRecord(
        actor.user.id,
        input.credentialId,
        input.zoneId,
        {
          action: input.action,
          id: input.id,
          record: input.record,
        },
      ),
    };
  }
  if (action === "mcp.connections.list")
    return {
      endpoint: localMcpUrls().resource,
      connections: await listMcpConnections(actor.user.id, actor.user.username),
    };
  if (action === "mcp.connections.create") {
    const input = z
      .object({
        name: z.string().trim().min(1).max(80),
        expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365)]),
      })
      .strict()
      .parse(submitted);
    return createMcpPersonalToken(
      actor.user.id,
      actor.user.username,
      input,
      localMcpUrls(),
    );
  }
  if (action === "mcp.connections.revoke") {
    const input = z.object({ id: z.string().uuid() }).strict().parse(submitted);
    await revokeMcpConnection(actor.user.id, actor.user.username, input.id);
    return listMcpConnections(actor.user.id, actor.user.username);
  }
  if (action === "panel.settings.get") {
    const [update, notifications, monitoring, security] = await Promise.all([
      getUpdateState(),
      getPublicNotificationSettings(),
      getMonitoringSettings(),
      getSecuritySettings(),
    ]);
    return { update, notifications, monitoring, security };
  }
  if (action === "panel.update.manage") {
    const input = z
      .discriminatedUnion("action", [
        z
          .object({
            action: z.literal("save-repository"),
            repository: z.string(),
          })
          .strict(),
        z.object({ action: z.literal("update") }).strict(),
      ])
      .parse(submitted);
    if (input.action === "save-repository") {
      await setUpdateRepository(validateUpdateRepository(input.repository));
      return getUpdateState(true);
    }
    return queueUpdate();
  }
  if (action === "panel.notifications.manage") {
    const input = z
      .discriminatedUnion("action", [
        z
          .object({
            action: z.literal("save"),
            settings: notificationSettingsSchema,
          })
          .strict(),
        z.object({ action: z.literal("test") }).strict(),
      ])
      .parse(submitted);
    if (input.action === "save")
      return saveNotificationSettings(input.settings);
    const result = await sendNotification({
      title: "Test notification",
      message: "Panelavo notification delivery is configured.",
      severity: "info",
      event: "notifications.test",
    });
    if (
      !result.configured ||
      result.email === false ||
      result.webhook === false
    )
      throw new AppError(
        "SITE_UPDATE_FAILED",
        "One or more configured notification channels rejected the test.",
        502,
      );
    return result;
  }
  if (action === "panel.monitoring.save")
    return saveMonitoringSettings(monitoringSettingsSchema.parse(submitted));
  if (action === "panel.security.save")
    return setSecuritySettings(
      z
        .object({
          sessionLifetimeMinutes: z.number().int().min(15).max(10_080),
          passwordMinLength: z.number().int().min(12).max(128),
          requireUppercase: z.boolean(),
          requireLowercase: z.boolean(),
          requireNumber: z.boolean(),
          requireSymbol: z.boolean(),
        })
        .strict()
        .parse(submitted),
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
      return createUserInvitation(actor, input, localMcpUrls().origin);
    const username = String(input.username ?? "").toLowerCase();
    const roles: PanelRole[] = ["super-admin", "manager", "admin", "user"];
    let panelRole: PanelRole | undefined;
    if (userAction === "add" || userAction === "update") {
      panelRole = roles.find((role) => role === String(input.role ?? ""));
      if (!panelRole)
        throw new AppError("INVALID_REQUEST", "Unknown role.", 400);
      input.role = cloudRoleFor(panelRole);
    }
    const target = ["reset-password", "delete", "update"].includes(userAction)
      ? (await client.listUsers(actor.cloudPanel)).find(
          (user) => user.username.toLowerCase() === username,
        )
      : undefined;
    await client.manageUser(actor.cloudPanel, input);
    if (panelRole) await setPanelAdmin(username, panelRole === "admin");
    if (userAction === "delete") await setPanelAdmin(username, false);
    if (target) await revokeAllMcpConnections(target.id, target.username);
    if (target) await revokeFleetAuthorizations(target);
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
