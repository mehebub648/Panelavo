"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  CheckCircle2,
  Copy,
  Globe2,
  LoaderCircle,
  Network,
  Plus,
  RefreshCw,
  Server,
  ServerOff,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { FleetHealthSnapshot } from "@/server/fleet/types";

type PublicState = {
  mode: "standalone" | "hub" | "node";
  hub?: { id: string; label: string; origin: string };
  nodeLink?: {
    connectionId: string;
    hubLabel: string;
    hubOrigin: string;
    status: string;
    owner: { username: string };
  };
  nodes: Array<{
    id: string;
    node: { label: string; origin: string; panelVersion: string };
    owner: { username: string };
    status: string;
  }>;
};

async function api(body?: unknown) {
  const response = await fetch(
    "/api/fleet",
    body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : { cache: "no-store" },
  );
  const result = await response.json();
  if (!result.success)
    throw new Error(
      result.error?.message || "Fleet could not complete the request.",
    );
  return result.data;
}

function pct(value?: number) {
  return `${Math.round(value ?? 0)}%`;
}

export function FleetManager({ initialState }: { initialState: PublicState }) {
  const [state, setState] = useState(initialState);
  const [servers, setServers] = useState<FleetHealthSnapshot[]>([]);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [serverSort, setServerSort] = useState<
    "name" | "status" | "sites" | "latency"
  >("name");
  const [invitation, setInvitation] = useState("");
  const [selectedNodes, setSelectedNodes] = useState<string[]>([]);
  const [rollingStatus, setRollingStatus] = useState<string>();
  const [hubForm, setHubForm] = useState({
    label: "Panelavo Fleet",
    password: "",
    confirmation: "",
  });
  const [connectForm, setConnectForm] = useState({
    invitation: "",
    password: "",
    confirmation: "",
  });

  const refresh = useCallback(async (notice = false) => {
    setBusy(true);
    try {
      const response = await fetch("/api/fleet/servers?refresh=true", {
        cache: "no-store",
      });
      const result = await response.json();
      if (!result.success)
        throw new Error(
          result.error?.message || "Fleet servers could not be refreshed.",
        );
      setState(result.data.state);
      setServers(result.data.servers ?? []);
      if (notice) toast.success("Fleet refreshed");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Fleet refresh failed.",
      );
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (state.mode === "hub") void refresh();
  }, [refresh, state.mode]);
  useEffect(() => {
    if (state.mode !== "hub") return;
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 60_000);
    return () => clearInterval(timer);
  }, [refresh, state.mode]);

  async function mutate(body: unknown, success: string) {
    setBusy(true);
    try {
      const next = await api(body);
      setState(next.mode ? next : await api());
      toast.success(success);
      return next;
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Fleet request failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function startRollingUpdate() {
    if (
      window.prompt(
        "Type ROLLING UPDATE to update the selected Nodes sequentially.",
      ) !== "ROLLING UPDATE"
    )
      return;
    setBusy(true);
    try {
      const response = await fetch("/api/fleet/rolling-updates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serverIds: selectedNodes,
          confirmation: "ROLLING UPDATE",
        }),
      });
      const result = await response.json();
      if (!result.success)
        throw new Error(
          result.error?.message || "The rolling update could not start.",
        );
      setRollingStatus(
        "Rolling update started. Nodes update one at a time and stop on the first failure.",
      );
      toast.success("Rolling update started");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The rolling update could not start.",
      );
    } finally {
      setBusy(false);
    }
  }

  const visibleServers = useMemo(
    () =>
      servers.filter((server) =>
        [
          server.label,
          server.origin,
          ...(server.summary?.sites.map((site) => site.domain) ?? []),
        ].some((value) => value.toLowerCase().includes(query.toLowerCase())),
      ),
    [query, servers],
  );
  const sortedServers = useMemo(
    () =>
      [...visibleServers].sort((left, right) => {
        if (serverSort === "status")
          return (
            left.status.localeCompare(right.status) ||
            left.label.localeCompare(right.label)
          );
        if (serverSort === "sites")
          return (
            (right.summary?.sites.length ?? 0) -
              (left.summary?.sites.length ?? 0) ||
            left.label.localeCompare(right.label)
          );
        if (serverSort === "latency")
          return (
            (left.latencyMs ?? Number.MAX_SAFE_INTEGER) -
            (right.latencyMs ?? Number.MAX_SAFE_INTEGER)
          );
        return left.label.localeCompare(right.label);
      }),
    [serverSort, visibleServers],
  );
  const sites = visibleServers.flatMap((server) =>
    (server.summary?.sites ?? []).map((site) => ({
      ...site,
      fleetServerId: server.serverId,
      fleetServerLabel: server.label,
    })),
  );
  const counts = {
    online: servers.filter((item) => item.status === "online").length,
    offline: servers.filter((item) => item.status === "offline").length,
    warning: servers.filter(
      (item) =>
        item.status === "degraded" ||
        (item.summary &&
          Math.max(
            item.summary.resources.cpu.usedPercent,
            item.summary.resources.memory.usedPercent,
            item.summary.resources.disk.usedPercent,
          ) >= 85),
    ).length,
  };

  if (state.mode === "standalone")
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <div>
          <h2 className="text-2xl font-bold text-ink">Connect your servers</h2>
          <p className="mt-1 text-sm text-slate-500">
            Make this panel the central Hub, or connect it to an existing Hub.
          </p>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <form
            className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-card"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(
                {
                  action: "enable-hub",
                  label: hubForm.label,
                  currentPassword: hubForm.password,
                  confirmation: hubForm.confirmation,
                },
                "Fleet Hub enabled",
              );
            }}
          >
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-panel-50 text-panel-600">
              <Network />
            </span>
            <div>
              <h3 className="font-bold">Create the central Hub</h3>
              <p className="mt-1 text-sm text-slate-500">
                This server becomes the place where your Super Admins manage
                every connected panel.
              </p>
            </div>
            <div>
              <Label>Fleet name</Label>
              <Input
                value={hubForm.label}
                onChange={(e) =>
                  setHubForm({ ...hubForm, label: e.target.value })
                }
              />
            </div>
            <div>
              <Label>Current Panelavo password</Label>
              <Input
                type="password"
                autoComplete="current-password"
                value={hubForm.password}
                onChange={(e) =>
                  setHubForm({ ...hubForm, password: e.target.value })
                }
              />
            </div>
            <div>
              <Label>Type ENABLE FLEET HUB</Label>
              <Input
                value={hubForm.confirmation}
                onChange={(e) =>
                  setHubForm({ ...hubForm, confirmation: e.target.value })
                }
              />
            </div>
            <Button
              disabled={
                busy ||
                !hubForm.password ||
                hubForm.confirmation !== "ENABLE FLEET HUB"
              }
            >
              {busy && <LoaderCircle className="h-4 w-4 animate-spin" />} Enable
              Hub
            </Button>
          </form>
          <form
            className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-card"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(
                {
                  action: "connect",
                  invitation: connectForm.invitation,
                  currentPassword: connectForm.password,
                  confirmation: connectForm.confirmation,
                },
                "Connected to Fleet Hub",
              );
            }}
          >
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-blue-50 text-blue-600">
              <Server />
            </span>
            <div>
              <h3 className="font-bold">Connect this server</h3>
              <p className="mt-1 text-sm text-slate-500">
                Paste the one-time invitation created on your central Hub.
              </p>
            </div>
            <div>
              <Label>Fleet invitation</Label>
              <Input
                value={connectForm.invitation}
                onChange={(e) =>
                  setConnectForm({ ...connectForm, invitation: e.target.value })
                }
              />
            </div>
            <div>
              <Label>Current Panelavo password</Label>
              <Input
                type="password"
                autoComplete="current-password"
                value={connectForm.password}
                onChange={(e) =>
                  setConnectForm({ ...connectForm, password: e.target.value })
                }
              />
            </div>
            <div>
              <Label>Hub hostname</Label>
              <Input
                placeholder="panel.example.com"
                value={connectForm.confirmation}
                onChange={(e) =>
                  setConnectForm({
                    ...connectForm,
                    confirmation: e.target.value,
                  })
                }
              />
            </div>
            <Button
              disabled={
                busy ||
                !connectForm.invitation ||
                !connectForm.password ||
                !connectForm.confirmation
              }
            >
              {busy && <LoaderCircle className="h-4 w-4 animate-spin" />}{" "}
              Connect server
            </Button>
          </form>
        </div>
      </div>
    );

  if (state.mode === "node")
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        <div>
          <h2 className="text-2xl font-bold text-ink">Connected Fleet Node</h2>
          <p className="mt-1 text-sm text-slate-500">
            Only local Super Admins can see or change this connection.
          </p>
        </div>
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card">
          <div className="flex items-start justify-between gap-4">
            <div className="flex gap-3">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-emerald-50 text-emerald-600">
                <CheckCircle2 />
              </span>
              <div>
                <h3 className="font-bold">{state.nodeLink?.hubLabel}</h3>
                <p className="text-sm text-slate-500">
                  {state.nodeLink?.hubOrigin}
                </p>
                <p className="mt-2 text-xs text-slate-400">
                  Authorized by {state.nodeLink?.owner.username} ·{" "}
                  {state.nodeLink?.status}
                </p>
              </div>
            </div>
          </div>
          <Button
            className="mt-6"
            variant="danger"
            disabled={busy}
            onClick={() =>
              void mutate(
                { action: "disconnect-hub", confirmation: "DISCONNECT FLEET" },
                "Fleet disconnected",
              )
            }
          >
            <Unplug className="h-4 w-4" /> Disconnect
          </Button>
        </section>
      </div>
    );

  return (
    <div className="mx-auto max-w-[1500px] space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-2xl font-bold text-ink">{state.hub?.label}</h2>
          <p className="mt-1 text-sm text-slate-500">
            One view of this server and every connected Panelavo Node.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => void startRollingUpdate()}
            disabled={busy || !selectedNodes.length}
          >
            Update selected ({selectedNodes.length})
          </Button>
          <Button
            variant="outline"
            onClick={() => void refresh(true)}
            disabled={busy}
          >
            <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />{" "}
            Refresh
          </Button>
          <Button
            onClick={async () => {
              const value = await mutate(
                { action: "create-invitation" },
                "Invitation created",
              );
              if (value?.invitation) setInvitation(value.invitation);
            }}
            disabled={busy}
          >
            <Plus className="h-4 w-4" /> Connect Node
          </Button>
        </div>
      </div>
      {rollingStatus && (
        <p className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
          {rollingStatus}
        </p>
      )}
      {invitation && (
        <section className="rounded-2xl border border-blue-200 bg-blue-50 p-5">
          <h3 className="font-bold text-blue-950">One-time invitation</h3>
          <p className="mt-1 text-sm text-blue-800">
            Expires in 10 minutes. Paste it into the other panel&apos;s Fleet
            page.
          </p>
          <div className="mt-3 flex gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-slate-950 p-3 text-xs text-white">
              {invitation}
            </code>
            <Button
              variant="outline"
              size="icon"
              onClick={() => {
                void navigator.clipboard.writeText(invitation);
                toast.success("Invitation copied");
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </section>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: "Online servers",
            value: counts.online,
            Icon: CheckCircle2,
            color: "text-emerald-600 bg-emerald-50",
          },
          {
            label: "Attention",
            value: counts.warning,
            Icon: TriangleAlert,
            color: "text-amber-600 bg-amber-50",
          },
          {
            label: "Offline",
            value: counts.offline,
            Icon: ServerOff,
            color: "text-red-600 bg-red-50",
          },
          {
            label: "Websites",
            value: servers.reduce(
              (sum, item) => sum + (item.summary?.sites.length ?? 0),
              0,
            ),
            Icon: Globe2,
            color: "text-panel-600 bg-panel-50",
          },
        ].map(({ label, value, Icon, color }) => (
          <div
            key={label}
            className="rounded-2xl border border-white/60 bg-white p-5 shadow-card"
          >
            <span
              className={`grid h-10 w-10 place-items-center rounded-xl ${color}`}
            >
              <Icon className="h-5 w-5" />
            </span>
            <p className="mt-3 text-2xl font-bold">{value}</p>
            <p className="text-sm text-slate-500">{label}</p>
          </div>
        ))}
      </div>
      <div className="relative">
        <Activity className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input
          className="pl-10"
          placeholder="Search servers or websites…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card lg:hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h3 className="font-bold">Servers</h3>
          <button
            className="text-xs font-semibold text-panel-700"
            onClick={() => setSelectedNodes(state.nodes.map((node) => node.id))}
          >
            Select all Nodes
          </button>
        </div>
        <div className="grid gap-px bg-slate-100">
          {sortedServers.map((server) => (
            <div
              key={server.serverId}
              className="relative bg-white p-5 transition hover:bg-slate-50"
            >
              {server.serverId !== "local" && (
                <input
                  aria-label={`Select ${server.label}`}
                  type="checkbox"
                  className="absolute right-5 top-5 h-4 w-4"
                  checked={selectedNodes.includes(server.serverId)}
                  onChange={(event) =>
                    setSelectedNodes((current) =>
                      event.target.checked
                        ? [...new Set([...current, server.serverId])]
                        : current.filter((id) => id !== server.serverId),
                    )
                  }
                />
              )}
              <Link
                href={`/fleet/servers/${server.serverId}`}
                className="block pr-8"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h4 className="font-bold">{server.label}</h4>
                    <p className="text-xs text-slate-400">{server.origin}</p>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-bold ${server.status === "online" ? "bg-emerald-50 text-emerald-700" : server.status === "offline" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"}`}
                  >
                    {server.status}
                  </span>
                </div>
                {server.summary && (
                  <div className="mt-4 grid grid-cols-3 gap-2 text-xs text-slate-500">
                    <span>
                      CPU{" "}
                      <b className="text-slate-800">
                        {pct(server.summary.resources.cpu.usedPercent)}
                      </b>
                    </span>
                    <span>
                      Memory{" "}
                      <b className="text-slate-800">
                        {pct(server.summary.resources.memory.usedPercent)}
                      </b>
                    </span>
                    <span>
                      Disk{" "}
                      <b className="text-slate-800">
                        {pct(server.summary.resources.disk.usedPercent)}
                      </b>
                    </span>
                  </div>
                )}
                <p className="mt-3 text-xs text-slate-400">
                  {server.summary?.sites.length ?? 0} websites ·{" "}
                  {server.latencyMs ?? "—"} ms
                </p>
              </Link>
            </div>
          ))}
        </div>
      </section>
      <section className="hidden overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-card lg:block">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h3 className="font-bold">Servers</h3>
          <button
            className="text-xs font-semibold text-panel-700"
            onClick={() => setSelectedNodes(state.nodes.map((node) => node.id))}
          >
            Select all Nodes
          </button>
        </div>
        <table className="w-full min-w-[1180px] text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-400">
            <tr>
              <th className="w-12 px-4 py-3">Pick</th>
              {[
                ["name", "Server"],
                ["status", "Status"],
                ["sites", "Sites"],
                ["latency", "Latency"],
              ].map(([id, label]) => (
                <th key={id} className="px-4 py-3">
                  <button
                    onClick={() => setServerSort(id as typeof serverSort)}
                  >
                    {label}
                    {serverSort === id ? " ↓" : ""}
                  </button>
                </th>
              ))}
              <th className="px-4 py-3">Pressure</th>
              <th className="px-4 py-3">Runtime</th>
              <th className="px-4 py-3">Last contact</th>
            </tr>
          </thead>
          <tbody>
            {sortedServers.map((server) => (
              <tr
                key={server.serverId}
                className="border-t border-slate-100 hover:bg-slate-50"
              >
                <td className="px-4 py-3">
                  {server.serverId !== "local" && (
                    <input
                      aria-label={`Select ${server.label}`}
                      type="checkbox"
                      checked={selectedNodes.includes(server.serverId)}
                      onChange={(event) =>
                        setSelectedNodes((current) =>
                          event.target.checked
                            ? [...new Set([...current, server.serverId])]
                            : current.filter((id) => id !== server.serverId),
                        )
                      }
                    />
                  )}
                </td>
                <td className="px-4 py-3">
                  <Link
                    className="font-semibold text-panel-700 hover:underline"
                    href={`/fleet/servers/${server.serverId}`}
                  >
                    {server.label}
                  </Link>
                  <p className="text-xs text-slate-400">{server.origin}</p>
                </td>
                <td className="px-4 py-3 capitalize">{server.status}</td>
                <td className="px-4 py-3">
                  {server.summary?.sites.length ?? 0}
                </td>
                <td className="px-4 py-3">{server.latencyMs ?? "—"} ms</td>
                <td className="px-4 py-3 text-xs">
                  CPU {pct(server.summary?.resources.cpu.usedPercent)} · MEM{" "}
                  {pct(server.summary?.resources.memory.usedPercent)} · DISK{" "}
                  {pct(server.summary?.resources.disk.usedPercent)}
                </td>
                <td className="px-4 py-3 text-xs">
                  {server.summary ? (
                    <>
                      <b>v{server.summary.panelVersion}</b>
                      <br />
                      Broker {server.summary.brokerProtocolVersion} ·{" "}
                      {server.summary.update.status}
                      <br />
                      Up{" "}
                      {Math.floor(
                        server.summary.resources.uptimeSeconds / 86400,
                      )}
                      d
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-slate-500">
                  {server.lastSuccessfulAt
                    ? new Date(server.lastSuccessfulAt).toLocaleString()
                    : "Never"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
        <div className="border-b border-slate-100 px-5 py-4">
          <h3 className="font-bold">All websites</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-400">
              <tr>
                <th className="px-5 py-3">Website</th>
                <th className="px-5 py-3">Server</th>
                <th className="px-5 py-3">Type</th>
                <th className="px-5 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((site) => (
                <tr
                  key={`${site.fleetServerId}:${site.domain}`}
                  className="border-t border-slate-100"
                >
                  <td className="px-5 py-3 font-semibold">
                    <Link
                      className="text-panel-700 hover:underline"
                      href={`/fleet/servers/${site.fleetServerId}/sites/${encodeURIComponent(site.domain)}/settings`}
                    >
                      {site.label || site.domain}
                    </Link>
                    <p className="text-xs font-normal text-slate-400">
                      {site.domain}
                    </p>
                  </td>
                  <td className="px-5 py-3">{site.fleetServerLabel}</td>
                  <td className="px-5 py-3">{site.type ?? "—"}</td>
                  <td className="px-5 py-3">{site.status ?? "unknown"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!sites.length && (
            <p className="p-8 text-center text-sm text-slate-400">
              No matching websites.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
