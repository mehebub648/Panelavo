"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  Activity,
  Cpu,
  HardDrive,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { UserManager } from "@/components/users/user-manager";
import { VpnManager } from "@/components/vpn/vpn-manager";
import { ResourcesView } from "@/components/server/resources-view";
import { ServerInformationView } from "@/components/server/server-information-view";
import { DomainManager } from "@/components/domains/domain-manager";
import { McpSetupGuide } from "@/components/mcp/mcp-setup-guide";
import type { PublicMcpConnection } from "@/server/mcp/oauth";
import { PanelAddress } from "@/components/settings/panel-address";
import { ConnectedServers } from "@/components/settings/connected-servers";
import { UpdateManager } from "@/components/settings/update-manager";
import {
  NotificationManager,
  type PublicNotificationSettings,
} from "@/components/settings/notification-manager";
import { MonitoringManager } from "@/components/settings/monitoring-manager";
import { SecurityPolicyManager } from "@/components/settings/security-policy-manager";
import type { MonitoringSettings } from "@/server/monitoring/store";
import type { SecuritySettings } from "@/server/settings/store";
import type { AuditPage } from "@/server/security/log";
import type { UpdateState } from "@/server/updates/panel-updater";
import type {
  CloudPanelSite,
  CloudPanelUser,
  ServerInfo,
  ServerInformation,
  ServerResources,
} from "@/types/cloudpanel";
import type { VpnState } from "@/types/vpn";
import { type FleetSection } from "@/lib/fleet-navigation";

type Tab = FleetSection;
type Summary = {
  label: string;
  origin: string;
  panelVersion: string;
  brokerProtocolVersion: number;
  server: ServerInfo;
  resources: ServerResources;
  sites: CloudPanelSite[];
  update: UpdateState;
};

async function call(serverId: string, action: string, input?: unknown) {
  const response = await fetch(
    `/api/fleet/servers/${encodeURIComponent(serverId)}/actions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, input }),
    },
  );
  const result = await response.json();
  if (!result.success)
    throw new Error(
      result.error?.message ||
        "The connected server could not complete the request.",
    );
  return result.data;
}

export function FleetServerWorkspace({
  serverId,
  label,
  user,
  tab = "overview",
}: {
  serverId: string;
  label: string;
  user: CloudPanelUser;
  tab?: Tab;
}) {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [resources, setResources] = useState<ServerResources | null>(null);
  const [info, setInfo] = useState<ServerInformation | null>(null);
  const [about, setAbout] = useState<Pick<
    Summary,
    "panelVersion" | "brokerProtocolVersion" | "server"
  > | null>(null);
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [users, setUsers] = useState<CloudPanelUser[]>([]);
  const [userSites, setUserSites] = useState<string[]>([]);
  const [audit, setAudit] = useState<AuditPage | null>(null);
  const [vpn, setVpn] = useState<VpnState | null>(null);
  const [mcp, setMcp] = useState<{
    endpoint: string;
    connections: PublicMcpConnection[];
  } | null>(null);
  const [settings, setSettings] = useState<{
    update: UpdateState;
    notifications: PublicNotificationSettings;
    monitoring: MonitoringSettings;
    security: SecuritySettings;
  } | null>(null);

  const load = useCallback(
    async (selected: Tab, notice = false) => {
      setBusy(true);
      setLoadError(null);
      try {
        if (selected === "settings")
          setSettings(await call(serverId, "panel.settings.get"));
        else if (selected === "overview")
          setSummary(await call(serverId, "system.summary"));
        else if (selected === "resources")
          setResources((await call(serverId, "system.resources")).resources);
        else if (selected === "information")
          setInfo(await call(serverId, "system.info"));
        else if (selected === "about")
          setAbout(await call(serverId, "system.about"));
        else if (selected === "updates")
          setUpdate(await call(serverId, "system.update.get"));
        else if (selected === "users") {
          const data = await call(serverId, "users.list");
          setUsers(data.users ?? []);
          setUserSites(data.sites ?? []);
        } else if (selected === "audit")
          setAudit(
            await call(serverId, "audit.list", { page: 1, pageSize: 50 }),
          );
        else if (selected === "vpn") setVpn(await call(serverId, "vpn.get"));
        else if (selected === "ai-access")
          setMcp(await call(serverId, "mcp.connections.list"));
        setLoaded(true);
        if (notice) toast.success("Server refreshed");
      } catch (error) {
        setLoadError(
          error instanceof Error
            ? error.message
            : "Server could not be loaded.",
        );
        toast.error(
          error instanceof Error
            ? error.message
            : "Server could not be loaded.",
        );
      } finally {
        setBusy(false);
      }
    },
    [serverId],
  );
  useEffect(() => {
    void load(tab);
  }, [load, tab]);

  return (
    <div className="mx-auto max-w-[1450px] space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-xl font-bold text-ink">{label}</h2>
          <p className="text-xs text-slate-500">Connected server</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => void load(tab, true)}
            disabled={busy}
          >
            <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />{" "}
            Refresh
          </Button>
        </div>
      </div>
      {busy && !loaded && (
        <div className="grid min-h-72 place-items-center">
          <LoaderCircle className="h-7 w-7 animate-spin text-panel-600" />
        </div>
      )}
      {loadError && (
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700"
        >
          {loadError} Use Refresh to try again, or switch to another server.
        </p>
      )}
      {summary && tab === "overview" && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["Panelavo", `v${summary.panelVersion}`],
              ["Websites", String(summary.sites.length)],
              [
                "Uptime",
                `${Math.floor(summary.server.uptimeSeconds / 86400)} days`,
              ],
              ["Update", summary.update.status],
            ].map(([key, value]) => (
              <div
                key={key}
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card"
              >
                <p className="text-xs font-bold uppercase text-slate-400">
                  {key}
                </p>
                <p className="mt-2 text-xl font-bold">{value}</p>
              </div>
            ))}
          </div>
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card">
            <h3 className="font-bold">Server health</h3>
            <div className="mt-5 grid gap-5 md:grid-cols-3">
              <Gauge
                icon={Cpu}
                label="CPU"
                value={summary.resources.cpu.usedPercent}
              />
              <Gauge
                icon={Activity}
                label="Memory"
                value={summary.resources.memory.usedPercent}
              />
              <Gauge
                icon={HardDrive}
                label="Disk"
                value={summary.resources.disk.usedPercent}
              />
            </div>
          </section>
        </div>
      )}
      {resources && tab === "resources" && (
        <ResourcesView
          initialData={resources}
          initialHistory={[]}
          canReclaimStorage
          apiBase={`/api/fleet/servers/${serverId}/proxy`}
        />
      )}
      {tab === "domains" && loaded && (
        <DomainManager apiBase={`/api/fleet/servers/${serverId}/proxy`} />
      )}
      {tab === "ai-access" && mcp && (
        <McpSetupGuide
          user={user}
          endpoint={mcp.endpoint}
          initialConnections={mcp.connections}
          apiBase={`/api/fleet/servers/${serverId}/proxy/api/profile/mcp-connections`}
        />
      )}
      {tab === "settings" && settings && (
        <div className="space-y-5">
          <ConnectedServers apiBase={`/api/fleet/servers/${serverId}/proxy`} />
          <PanelAddress apiBase={`/api/fleet/servers/${serverId}/proxy`} />
          <UpdateManager
            initialState={settings.update}
            apiBase={`/api/fleet/servers/${serverId}/proxy`}
          />
          <NotificationManager
            initialSettings={settings.notifications}
            apiBase={`/api/fleet/servers/${serverId}/proxy`}
          />
          <MonitoringManager
            initialSettings={settings.monitoring}
            apiBase={`/api/fleet/servers/${serverId}/proxy`}
          />
          <SecurityPolicyManager
            initialSettings={settings.security}
            apiBase={`/api/fleet/servers/${serverId}/proxy`}
          />
        </div>
      )}
      {info && tab === "information" && <ServerInformationView info={info} />}
      {about && tab === "about" && (
        <div className="grid gap-4 md:grid-cols-3">
          {[
            ["Panelavo", `v${about.panelVersion}`],
            ["Broker protocol", String(about.brokerProtocolVersion)],
            ["Server", about.server.hostname],
          ].map(([title, detail]) => (
            <section
              key={title}
              className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card"
            >
              <p className="text-xs font-bold uppercase tracking-wide text-slate-400">
                {title}
              </p>
              <p className="mt-2 break-words text-lg font-bold text-ink">
                {detail}
              </p>
            </section>
          ))}
        </div>
      )}
      {tab === "users" && loaded && (
        <div className="space-y-3">
          <UserManager
            initialUsers={users}
            sites={userSites}
            apiBase={`/api/fleet/servers/${serverId}/proxy`}
          />
        </div>
      )}
      {tab === "audit" && audit && (
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
          <div className="border-b border-slate-100 p-5">
            <h3 className="font-bold">Server audit</h3>
            <p className="text-sm text-slate-500">
              {audit.pagination.total} retained events · integrity{" "}
              {audit.integrity.valid ? "verified" : "needs attention"}
            </p>
          </div>
          <div className="divide-y divide-slate-100">
            {audit.events.map((event) => (
              <div
                key={event.id}
                className="grid gap-1 p-4 text-sm sm:grid-cols-[180px_1fr_120px]"
              >
                <span className="text-xs text-slate-400">
                  {new Date(event.timestamp).toLocaleString()}
                </span>
                <span className="font-semibold">{event.action}</span>
                <span
                  className={
                    event.result === "success"
                      ? "text-emerald-600"
                      : "text-red-600"
                  }
                >
                  {event.result}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
      {tab === "vpn" && vpn && (
        <VpnManager
          initialState={vpn}
          apiBase={`/api/fleet/servers/${serverId}/proxy`}
        />
      )}
      {update && tab === "updates" && (
        <UpdateManager
          initialState={update}
          apiBase={`/api/fleet/servers/${serverId}/proxy`}
        />
      )}
    </div>
  );
}

function Gauge({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Cpu;
  label: string;
  value: number;
  detail?: string;
}) {
  const rounded = Math.round(value);
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
      <div className="flex items-center justify-between">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-panel-50 text-panel-600">
          <Icon className="h-5 w-5" />
        </span>
        <b
          className={
            rounded >= 90
              ? "text-red-600"
              : rounded >= 70
                ? "text-amber-600"
                : "text-emerald-600"
          }
        >
          {rounded}%
        </b>
      </div>
      <p className="mt-4 text-sm font-bold">{label}</p>
      {detail && <p className="text-xs text-slate-400">{detail}</p>}
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full ${rounded >= 90 ? "bg-red-500" : rounded >= 70 ? "bg-amber-500" : "bg-panel-600"}`}
          style={{ width: `${Math.min(100, Math.max(0, rounded))}%` }}
        />
      </div>
    </div>
  );
}
