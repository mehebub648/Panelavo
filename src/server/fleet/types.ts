import type { AuditPage, AuditQuery } from "@/server/security/log";
import type { UpdateState } from "@/server/updates/panel-updater";
import type {
  CloudPanelSite,
  CloudPanelUser,
  ResourceHistoryPoint,
  ServerInfo,
  ServerResources,
} from "@/types/cloudpanel";

export const FLEET_PROTOCOL_VERSION = 1 as const;
export const FLEET_MAX_NODES = 100;

export type FleetMode = "standalone" | "hub" | "node";
export type FleetConnectionStatus =
  "pending" | "online" | "degraded" | "offline" | "suspended";

export const FLEET_CAPABILITIES = [
  "system.read",
  "system.storage",
  "system.update",
  "sites.read",
  "sites.write",
  "site-sections.read",
  "site-sections.write",
  "users.read",
  "users.write",
  "vpn.read",
  "vpn.write",
  "audit.read",
] as const;
export type FleetCapability = (typeof FLEET_CAPABILITIES)[number];

export type FleetNodeDescriptor = {
  nodeId: string;
  label: string;
  origin: string;
  panelVersion: string;
  brokerProtocolVersion: number;
  fleetProtocolVersion: number;
  capabilities: FleetCapability[];
  publicKey: string;
};

export type FleetConnection = {
  id: string;
  node: FleetNodeDescriptor;
  hubId: string;
  hubPublicKey: string;
  hubPrivateKey: string;
  owner: { id: string; username: string };
  createdAt: string;
  connectedAt?: string;
  lastSeenAt?: string;
  lastError?: string;
  status: FleetConnectionStatus;
};

export type FleetNodeLink = {
  connectionId: string;
  hubId: string;
  hubOrigin: string;
  hubLabel: string;
  hubPublicKey: string;
  previousHubPublicKey?: string;
  previousHubPublicKeyExpiresAt?: string;
  nodePrivateKey: string;
  nodePublicKey: string;
  owner: { id: string; username: string };
  createdAt: string;
  connectedAt?: string;
  status: FleetConnectionStatus;
};

export type FleetInvitation = {
  id: string;
  codeHash: string;
  createdAt: string;
  expiresAt: string;
  createdBy: { id: string; username: string };
};

export type FleetHealthSnapshot = {
  serverId: string;
  label: string;
  origin: string;
  status: FleetConnectionStatus;
  latencyMs?: number;
  checkedAt: string;
  lastSuccessfulAt?: string;
  error?: string;
  summary?: FleetServerSummary;
};

export type FleetServerSummary = {
  nodeId: string;
  label: string;
  origin: string;
  panelVersion: string;
  brokerProtocolVersion: number;
  fleetProtocolVersion: number;
  server: ServerInfo;
  resources: ServerResources;
  sites: CloudPanelSite[];
  update: UpdateState;
};

export type FleetActionName =
  | "fleet.rotate-key"
  | "system.summary"
  | "system.resources"
  | "system.storage"
  | "system.storage.refresh"
  | "system.storage.reclaim"
  | "system.info"
  | "system.update.get"
  | "system.update.start"
  | "sites.list"
  | "sites.creation-details"
  | "sites.create"
  | "site.get"
  | "site.update"
  | "site.delete"
  | "site.section.get"
  | "site.section.manage"
  | "site.domains.get"
  | "site.domains.manage"
  | "site.dns.get"
  | "site.dns.manage"
  | "site.uptime.get"
  | "site.uptime.save"
  | "site.deploy-hooks.get"
  | "site.deploy-hooks.save"
  | "site.services.list"
  | "site.services.create"
  | "site.service.verify"
  | "site.service.update"
  | "site.service.delete"
  | "site.backup-automation.get"
  | "site.backup-schedule.save"
  | "site.offsite.save"
  | "site.offsite.manage"
  | "site.offsite.remove"
  | "users.list"
  | "users.manage"
  | "vpn.get"
  | "vpn.manage"
  | "audit.list";

export const FLEET_ACTION_NAMES = [
  "fleet.rotate-key",
  "system.summary",
  "system.resources",
  "system.storage",
  "system.storage.refresh",
  "system.storage.reclaim",
  "system.info",
  "system.update.get",
  "system.update.start",
  "sites.list",
  "sites.creation-details",
  "sites.create",
  "site.get",
  "site.update",
  "site.delete",
  "site.section.get",
  "site.section.manage",
  "site.domains.get",
  "site.domains.manage",
  "site.dns.get",
  "site.dns.manage",
  "site.uptime.get",
  "site.uptime.save",
  "site.deploy-hooks.get",
  "site.deploy-hooks.save",
  "site.services.list",
  "site.services.create",
  "site.service.verify",
  "site.service.update",
  "site.service.delete",
  "site.backup-automation.get",
  "site.backup-schedule.save",
  "site.offsite.save",
  "site.offsite.manage",
  "site.offsite.remove",
  "users.list",
  "users.manage",
  "vpn.get",
  "vpn.manage",
  "audit.list",
] as const satisfies readonly FleetActionName[];

export type FleetActionRequest = {
  action: FleetActionName;
  input?: unknown;
};

export type FleetSignedProtected = {
  typ: "panelavo-federation-request+json" | "panelavo-federation-response+json";
  alg: "Ed25519";
  protocol: typeof FLEET_PROTOCOL_VERSION;
  connectionId: string;
  issuerId: string;
  audienceId: string;
  actorId: string;
  actorUsername: string;
  action: string;
  requestId: string;
  issuedAt: number;
  expiresAt: number;
};

export type FleetSignedEnvelope = {
  protected: string;
  payload: string;
  signature: string;
};

export type FleetServerWorkspaceData = {
  summary?: FleetServerSummary;
  resources?: { resources: ServerResources; history: ResourceHistoryPoint[] };
  sites?: CloudPanelSite[];
  users?: CloudPanelUser[];
  audit?: AuditPage;
  update?: UpdateState;
  auditQuery?: AuditQuery;
};

export type FleetRollingUpdate = {
  id: string;
  serverIds: string[];
  completedServerIds: string[];
  currentServerId?: string;
  status: "queued" | "running" | "failed" | "complete";
  createdBy: { id: string; username: string };
  createdAt: string;
  updatedAt: string;
  error?: string;
};
