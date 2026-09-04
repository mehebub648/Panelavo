"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  Cpu,
  Globe2,
  HardDrive,
  Info,
  LoaderCircle,
  RefreshCw,
  ScrollText,
  Server,
  Shield,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { UserManager } from "@/components/users/user-manager";
import { VpnManager } from "@/components/vpn/vpn-manager";
import { ResourcesView } from "@/components/server/resources-view";
import type { AuditPage } from "@/server/security/log";
import type { UpdateState } from "@/server/updates/panel-updater";
import type {
  CloudPanelSite,
  CloudPanelUser,
  ServerInfo,
  ServerResources,
} from "@/types/cloudpanel";
import type { VpnState } from "@/types/vpn";

type Tab =
  | "overview"
  | "websites"
  | "resources"
  | "information"
  | "vpn"
  | "users"
  | "audit"
  | "updates";
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
      result.error?.message || "The Fleet Node could not complete the request.",
    );
  return result.data;
}

const tabs: Array<{ id: Tab; label: string; icon: typeof Server }> = [
  { id: "overview", label: "Overview", icon: Server },
  { id: "websites", label: "Websites", icon: Globe2 },
  { id: "resources", label: "Resources", icon: Activity },
  { id: "information", label: "Information", icon: Info },
  { id: "vpn", label: "VPN", icon: Shield },
  { id: "users", label: "Users", icon: Users },
  { id: "audit", label: "Audit", icon: ScrollText },
  { id: "updates", label: "Updates", icon: RefreshCw },
];

export function FleetServerWorkspace({
  serverId,
  label,
}: {
  serverId: string;
  label: string;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [users, setUsers] = useState<CloudPanelUser[]>([]);
  const [userSites, setUserSites] = useState<string[]>([]);
  const [audit, setAudit] = useState<AuditPage | null>(null);
  const [vpn, setVpn] = useState<VpnState | null>(null);

  const load = useCallback(
    async (selected: Tab, notice = false) => {
      setBusy(true);
      try {
        if (
          [
            "overview",
            "websites",
            "resources",
            "information",
            "updates",
          ].includes(selected)
        )
          setSummary(await call(serverId, "system.summary"));
        else if (selected === "users") {
          const data = await call(serverId, "users.list");
          setUsers(data.users ?? []);
          setUserSites(data.sites ?? []);
        } else if (selected === "audit")
          setAudit(
            await call(serverId, "audit.list", { page: 1, pageSize: 50 }),
          );
        else if (selected === "vpn") setVpn(await call(serverId, "vpn.get"));
        if (notice) toast.success("Server refreshed");
      } catch (error) {
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

  async function connectionAction(action: "rotate-key" | "disconnect-node") {
    const phrase = action === "rotate-key" ? "ROTATE FLEET KEY" : label;
    if (window.prompt(`Type ${phrase} to continue.`) !== phrase) return;
    setBusy(true);
    try {
      const response = await fetch("/api/fleet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, serverId, confirmation: phrase }),
      });
      const result = await response.json();
      if (!result.success)
        throw new Error(
          result.error?.message || "The Fleet connection could not be changed.",
        );
      toast.success(
        action === "rotate-key"
          ? "Fleet keys rotated"
          : "Fleet Node disconnected",
      );
      if (action === "disconnect-node") window.location.assign("/fleet");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The Fleet connection could not be changed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1450px] space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3">
          <Button asChild variant="outline" size="icon">
            <Link href="/fleet" aria-label="Back to Fleet">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-slate-400">
              Fleet server
            </p>
            <h2 className="text-2xl font-bold text-ink">
              {summary?.label || label}
            </h2>
            <p className="text-xs text-slate-400">{summary?.origin}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {serverId !== "local" && (
            <>
              <Button
                variant="outline"
                onClick={() => void connectionAction("rotate-key")}
                disabled={busy}
              >
                Rotate trust
              </Button>
              <Button
                variant="danger"
                onClick={() => void connectionAction("disconnect-node")}
                disabled={busy}
              >
                Disconnect
              </Button>
            </>
          )}
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
      <nav
        className="flex gap-1 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-2 shadow-card"
        aria-label="Fleet server sections"
      >
        {tabs.map(({ id, label: itemLabel, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold ${tab === id ? "bg-panel-50 text-panel-700" : "text-slate-500 hover:bg-slate-50"}`}
          >
            <Icon className="h-4 w-4" />
            {itemLabel}
          </button>
        ))}
      </nav>
      {busy && !summary && (
        <div className="grid min-h-72 place-items-center">
          <LoaderCircle className="h-7 w-7 animate-spin text-panel-600" />
        </div>
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
      {summary && tab === "websites" && (
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
          <div className="flex items-center justify-between border-b border-slate-100 p-5">
            <div>
              <h3 className="font-bold">Websites</h3>
              <p className="text-sm text-slate-500">
                {summary.sites.length} websites on this server
              </p>
            </div>
            <Button asChild>
              <Link href={`/fleet/servers/${serverId}/sites/new`}>
                Add website
              </Link>
            </Button>
          </div>
          <div className="divide-y divide-slate-100">
            {summary.sites.map((site) => (
              <Link
                key={site.domain}
                href={`/fleet/servers/${serverId}/sites/${encodeURIComponent(site.domain)}/settings`}
                className="flex items-center justify-between gap-4 p-5 hover:bg-slate-50"
              >
                <div>
                  <p className="font-semibold text-panel-700">
                    {site.label || site.domain}
                  </p>
                  <p className="text-xs text-slate-400">{site.domain}</p>
                </div>
                <div className="text-right text-xs text-slate-500">
                  <p>{site.type}</p>
                  <p>{site.status}</p>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
      {summary && tab === "resources" && (
        <ResourcesView
          initialData={summary.resources}
          initialHistory={[]}
          canReclaimStorage
          apiBase={`/api/fleet/servers/${serverId}/proxy`}
        />
      )}
      {summary && tab === "information" && (
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card">
          <dl className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {[
              ["Hostname", summary.server.hostname],
              ["Public IP", summary.server.ip],
              ["Operating system", summary.server.os],
              ["Kernel", summary.server.kernel],
              ["Architecture", summary.server.arch],
              [
                "Processor",
                `${summary.server.cpuModel} · ${summary.server.cpuCores} cores`,
              ],
            ].map(([key, value]) => (
              <div key={key}>
                <dt className="text-xs font-bold uppercase text-slate-400">
                  {key}
                </dt>
                <dd className="mt-1 font-semibold">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {tab === "users" && (
        <div className="space-y-3">
          <p className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
            The Fleet connection owner and passwordless invitations remain
            managed locally on this Node.
          </p>
          <UserManager
            initialUsers={users}
            sites={userSites}
            apiBase={`/api/fleet/servers/${serverId}/proxy`}
            allowInvites={false}
          />
        </div>
      )}
      {tab === "audit" && audit && (
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
          <div className="border-b border-slate-100 p-5">
            <h3 className="font-bold">Node audit</h3>
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
      {summary && tab === "updates" && (
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="font-bold">Panelavo update</h3>
              <p className="mt-1 text-sm text-slate-500">
                Current v{summary.panelVersion} · {summary.update.status}
              </p>
              {summary.update.notice && (
                <p className="mt-2 text-sm text-amber-700">
                  {summary.update.notice}
                </p>
              )}
            </div>
            <CheckCircle2 className="text-emerald-600" />
          </div>
          <div className="mt-5 flex gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await call(serverId, "system.update.get", { check: true });
                  await load("updates", true);
                } catch (error) {
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : "Update check failed.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Check updates
            </Button>
            <Button
              disabled={busy || summary.update.status !== "available"}
              onClick={async () => {
                if (
                  !confirm(
                    "Install the available Panelavo update on this server?",
                  )
                )
                  return;
                setBusy(true);
                try {
                  await call(serverId, "system.update.start", {
                    confirmation: "UPDATE PANELAVO",
                  });
                  toast.success("Update queued");
                } catch (error) {
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : "Update could not be queued.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Install update
            </Button>
          </div>
        </section>
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
