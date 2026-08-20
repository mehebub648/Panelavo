"use client";

import React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Cpu,
  ChevronLeft,
  ChevronRight,
  HardDrive,
  LoaderCircle,
  MemoryStick,
  RefreshCw,
  Search,
  Timer,
  UsersRound,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type {
  ResourceHistoryPoint,
  ServerResources,
  ServerStorageBreakdown,
} from "@/types/cloudpanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Metric = "cpu" | "memory" | "disk";
type WebsiteSort = "memory" | "cpu" | "disk" | "domain";

const PAGE_SIZE = 10;

const EMPTY_RESOURCES: ServerResources = {
  generatedAt: "",
  uptimeSeconds: 0,
  cpu: { cores: 1, load1: 0, load5: 0, load15: 0, usedPercent: 0 },
  memory: { totalBytes: 0, usedBytes: 0, availableBytes: 0, usedPercent: 0 },
  swap: { totalBytes: 0, usedBytes: 0 },
  disk: { totalBytes: 0, usedBytes: 0, availableBytes: 0, usedPercent: 0, mount: "/" },
  users: [],
  websites: [],
  shared: { cpuPercent: 0, memoryBytes: 0, processes: 0 },
  system: { cpuPercent: 0, memoryBytes: 0, processes: 0 },
  attribution: { memoryMethod: "pss", note: "" },
};

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function gaugeColor(percent: number) {
  return percent >= 90 ? "bg-red-500" : percent >= 70 ? "bg-amber-500" : "bg-panel-600";
}

function Gauge({ percent, className }: { percent: number; className?: string }) {
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-slate-100", className)}>
      <div
        className={cn("h-full rounded-full transition-all duration-500", gaugeColor(percent))}
        style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
      />
    </div>
  );
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// One table cell showing a raw value plus the two shares the user asked for:
// the slice of what's currently used, and the slice of total capacity. The
// gauge fills against capacity (share of total), so a full bar means the box
// is actually saturated — not merely that this row leads the others.
function UsageCell({
  primary,
  shareOfUsed,
  shareOfAvail,
}: {
  primary: string;
  shareOfUsed: number;
  shareOfAvail: number;
}) {
  return (
    <div className="w-32 space-y-1.5 sm:w-40">
      <p className="text-xs font-medium text-slate-600">{primary}</p>
      <Gauge percent={shareOfAvail} />
      <div className="flex items-center justify-between text-[10px] leading-none text-slate-400">
        <span>
          <b className="font-semibold text-slate-600">{round1(shareOfUsed)}%</b> of used
        </span>
        <span>
          <b className="font-semibold text-slate-600">{round1(shareOfAvail)}%</b> of total
        </span>
      </div>
    </div>
  );
}

// Lightweight SVG area chart over the sampled history (values are 0–100%).
function HistoryChart({
  points,
  accessor,
  height = 120,
  showAxis = true,
}: {
  points: ResourceHistoryPoint[];
  accessor: (point: ResourceHistoryPoint) => number;
  height?: number;
  showAxis?: boolean;
}) {
  if (points.length < 2)
    return (
      <div className="grid h-24 place-items-center rounded-xl border border-dashed border-slate-200 text-xs text-slate-400">
        Collecting history — check back in a few minutes.
      </div>
    );
  const width = 600;
  const first = points[0].t;
  const span = Math.max(1, points[points.length - 1].t - first);
  const coords = points.map((point) => ({
    x: ((point.t - first) / span) * width,
    y: height - (Math.max(0, Math.min(100, accessor(point))) / 100) * height,
  }));
  const line = coords.map((c, i) => `${i ? "L" : "M"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const label = (t: number) =>
    new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-28 w-full sm:h-32"
        preserveAspectRatio="none"
        role="img"
        aria-label="Usage history chart"
      >
        {[25, 50, 75].map((percent) => (
          <line
            key={percent}
            x1="0"
            x2={width}
            y1={height - (percent / 100) * height}
            y2={height - (percent / 100) * height}
            stroke="#e2e8f0"
            strokeWidth="1"
            strokeDasharray="4 4"
          />
        ))}
        <path d={area} fill="currentColor" className="text-panel-500/15" />
        <path d={line} fill="none" stroke="currentColor" strokeWidth="2" className="text-panel-600" />
      </svg>
      {showAxis && (
        <div className="mt-1 flex justify-between text-[10px] text-slate-400">
          <span>{label(points[0].t)}</span>
          <span>{label(points[Math.floor(points.length / 2)].t)}</span>
          <span>{label(points[points.length - 1].t)}</span>
        </div>
      )}
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  detail,
  percent,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  detail: string;
  percent?: number;
  onClick?: () => void;
}) {
  const Wrapper = onClick ? "button" : "div";
  return (
    <Wrapper
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "rounded-2xl border border-white/60 bg-white/70 p-5 text-left shadow-card backdrop-blur-md",
        onClick && "transition hover:-translate-y-0.5 hover:border-panel-300 hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-panel-500",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-panel-50 text-panel-600">
          <Icon className="h-5 w-5" />
        </span>
        {percent !== undefined && (
          <span className={cn(
            "rounded-full px-2.5 py-1 text-xs font-bold",
            percent >= 90 ? "bg-red-50 text-red-600" : percent >= 70 ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700",
          )}>
            {percent}%
          </span>
        )}
      </div>
      <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-lg font-bold text-ink sm:text-xl">{value}</p>
      <p className="mt-0.5 truncate text-xs text-slate-500">{detail}</p>
      {percent !== undefined && <Gauge percent={percent} className="mt-3" />}
      {onClick && <p className="mt-2 text-[11px] font-semibold text-panel-600">View details →</p>}
    </Wrapper>
  );
}

export function ResourcesView({
  initialData,
  initialHistory,
}: {
  initialData: ServerResources | null;
  initialHistory: ResourceHistoryPoint[];
}) {
  const [data, setData] = useState(initialData ?? EMPTY_RESOURCES);
  const [history, setHistory] = useState(initialHistory);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(initialData !== null);
  const [loadError, setLoadError] = useState("");
  const [detail, setDetail] = useState<Metric | null>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [activeOnly, setActiveOnly] = useState(false);
  const [sort, setSort] = useState<WebsiteSort>("memory");
  const [page, setPage] = useState(1);
  const [storage, setStorage] = useState<ServerStorageBreakdown | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageError, setStorageError] = useState("");

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setBusy(true);
    try {
      const result = await fetch("/api/server/resources", { cache: "no-store" }).then((r) => r.json());
      if (!result.success) throw new Error(result.error?.message || "Resources could not be loaded.");
      setData(result.data.resources as ServerResources);
      setHistory((result.data.history ?? []) as ResourceHistoryPoint[]);
      setLoaded(true);
      setLoadError("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Resources could not be loaded.";
      if (!loaded) setLoadError(message);
      if (!silent) toast.error(message);
    } finally {
      if (!silent) setBusy(false);
    }
  }, [loaded]);

  const loadStorage = useCallback(async (force = false) => {
    setStorageBusy(true);
    setStorageError("");
    try {
      const result = await fetch("/api/server/storage", {
        method: force ? "POST" : "GET",
        cache: "no-store",
      }).then((response) => response.json());
      if (!result.success)
        throw new Error(result.error?.message || "Storage analysis could not be loaded.");
      setStorage(result.data.storage as ServerStorageBreakdown);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Storage analysis could not be loaded.";
      setStorageError(message);
      if (force) toast.error(message);
    } finally {
      setStorageBusy(false);
    }
  }, []);

  // Render the route immediately, then load the privileged process snapshot.
  // A short server cache collapses concurrent viewers and polling requests.
  useEffect(() => {
    if (!loaded) void refresh(true);
    const interval = setInterval(() => {
      if (!document.hidden) void refresh(true);
    }, 15_000);
    return () => clearInterval(interval);
  }, [loaded, refresh]);

  useEffect(() => {
    if (detail === "disk" && !storage && !storageBusy && !storageError)
      void loadStorage();
  }, [detail, loadStorage, storage, storageBusy, storageError]);

  const maxCpu = Math.max(1, ...data.websites.map((entry) => entry.cpuPercent));
  const maxMemory = Math.max(1, ...data.websites.map((entry) => entry.memoryBytes));
  const maxDisk = Math.max(1, ...data.websites.map((entry) => entry.diskBytes ?? 0));

  // Denominators for the two per-row shares. "Used" totals are the sum across
  // listed users (so a row's share is its slice of the attributed pie);
  // "capacity" totals are the machine's full headroom for that resource. CPU is
  // in ps per-core units, so full capacity is cores × 100.
  const cpuCapacity = Math.max(1, data.cpu.cores * 100);
  const cpuUsedTotal = Math.max(1, data.cpu.usedPercent * data.cpu.cores);
  const memCapacity = Math.max(1, data.memory.totalBytes);
  const memUsedTotal = Math.max(1, data.memory.usedBytes);
  const diskCapacity = Math.max(1, data.disk.totalBytes);
  const diskUsedTotal = Math.max(1, data.disk.usedBytes);

  const websiteTypes = useMemo(
    () => [...new Set(data.websites.map((entry) => entry.type))].sort(),
    [data.websites],
  );
  const filteredWebsites = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...data.websites]
      .filter((entry) => typeFilter === "all" || entry.type === typeFilter)
      .filter((entry) => !activeOnly || entry.processes > 0 || entry.cpuPercent > 0 || entry.memoryBytes > 0)
      .filter((entry) => !needle || entry.domain.includes(needle) || entry.siteUser.toLowerCase().includes(needle))
      .sort((a, b) => {
        if (sort === "domain") return a.domain.localeCompare(b.domain);
        if (sort === "cpu") return b.cpuPercent - a.cpuPercent || a.domain.localeCompare(b.domain);
        if (sort === "disk") return (b.diskBytes ?? -1) - (a.diskBytes ?? -1) || a.domain.localeCompare(b.domain);
        return b.memoryBytes - a.memoryBytes || a.domain.localeCompare(b.domain);
      });
  }, [activeOnly, data.websites, query, sort, typeFilter]);
  const pageCount = Math.max(1, Math.ceil(filteredWebsites.length / PAGE_SIZE));
  const visibleWebsites = filteredWebsites.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => setPage(1), [activeOnly, query, sort, typeFilter]);
  useEffect(() => setPage((current) => Math.min(current, pageCount)), [pageCount]);

  const metricConfig: Record<Metric, {
    title: string;
    icon: React.ComponentType<{ className?: string }>;
    percent: number;
    accessor: (point: ResourceHistoryPoint) => number;
    facts: { label: string; value: string }[];
    consumers: { name: string; note: string; value: string; percent: number }[];
  }> = useMemo(() => ({
    cpu: {
      title: "CPU usage",
      icon: Cpu,
      percent: data.cpu.usedPercent,
      accessor: (point) => point.cpu,
      facts: [
        { label: "Cores", value: String(data.cpu.cores) },
        { label: "Load 1m", value: String(data.cpu.load1) },
        { label: "Load 5m", value: String(data.cpu.load5) },
        { label: "Load 15m", value: String(data.cpu.load15) },
      ],
      consumers: [...data.websites]
        .sort((a, b) => b.cpuPercent - a.cpuPercent)
        .filter((entry) => entry.cpuPercent > 0)
        .slice(0, 10)
        .map((entry) => ({
          name: entry.domain,
          note: `${entry.type} · ${entry.processes} processes`,
          value: `${entry.cpuPercent}%`,
          percent: (entry.cpuPercent / maxCpu) * 100,
        })),
    },
    memory: {
      title: "Memory usage",
      icon: MemoryStick,
      percent: data.memory.usedPercent,
      accessor: (point) => point.mem,
      facts: [
        { label: "Total", value: formatBytes(data.memory.totalBytes) },
        { label: "Used", value: formatBytes(data.memory.usedBytes) },
        { label: "Available", value: formatBytes(data.memory.availableBytes) },
        { label: "Swap", value: data.swap.totalBytes ? `${formatBytes(data.swap.usedBytes)} / ${formatBytes(data.swap.totalBytes)}` : "none" },
      ],
      consumers: [...data.websites]
        .sort((a, b) => b.memoryBytes - a.memoryBytes)
        .filter((entry) => entry.memoryBytes > 0)
        .slice(0, 10)
        .map((entry) => ({
          name: entry.domain,
          note: `${entry.type} · ${entry.processes} processes`,
          value: formatBytes(entry.memoryBytes),
          percent: (entry.memoryBytes / maxMemory) * 100,
        })),
    },
    disk: {
      title: "Disk usage",
      icon: HardDrive,
      percent: data.disk.usedPercent,
      accessor: (point) => point.disk,
      facts: [
        { label: "Mount", value: data.disk.mount },
        { label: "Total", value: formatBytes(data.disk.totalBytes) },
        { label: "Used", value: formatBytes(data.disk.usedBytes) },
        { label: "Free", value: formatBytes(data.disk.availableBytes) },
      ],
      consumers: [...data.websites]
        .filter((entry) => (entry.diskBytes ?? 0) > 0)
        .sort((a, b) => (b.diskBytes ?? 0) - (a.diskBytes ?? 0))
        .slice(0, 10)
        .map((entry) => ({
          name: entry.domain,
          note: entry.diskShared ? "shared application root" : "application root",
          value: formatBytes(entry.diskBytes ?? 0),
          percent: ((entry.diskBytes ?? 0) / maxDisk) * 100,
        })),
    },
  }), [data, maxCpu, maxMemory, maxDisk]);

  const active = detail ? metricConfig[detail] : null;

  if (!loaded) {
    return (
      <div className="w-full space-y-5">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-ink">Resources</h2>
          <p className="mt-1 text-sm text-slate-500">
            Website usage loads separately so this page stays available while the server is measured.
          </p>
        </div>
        <section className="grid min-h-56 place-items-center rounded-2xl border border-white/60 bg-white/70 p-8 text-center shadow-card backdrop-blur-md">
          {loadError ? (
            <div className="max-w-md">
              <p className="font-semibold text-slate-700">Resource data is temporarily unavailable.</p>
              <p className="mt-1 text-sm text-slate-500">{loadError}</p>
              <Button className="mt-4" onClick={() => void refresh()} disabled={busy}>
                {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Try again
              </Button>
            </div>
          ) : (
            <div>
              <LoaderCircle className="mx-auto h-7 w-7 animate-spin text-panel-600" />
              <p className="mt-3 font-semibold text-slate-700">Measuring website usage…</p>
              <p className="mt-1 text-sm text-slate-500">The page is ready; the first accurate process sample can take a moment.</p>
            </div>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="w-full space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-ink">Resources</h2>
          <p className="mt-1 text-sm text-slate-500">
            Live server totals with conservative, evidence-based usage for each website.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            Live
          </span>
          <Button variant="outline" onClick={() => void refresh()} disabled={busy}>
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={Cpu}
          label="CPU"
          value={`${data.cpu.usedPercent}% of ${data.cpu.cores} cores`}
          detail={`Load ${data.cpu.load1} / ${data.cpu.load5} / ${data.cpu.load15}`}
          percent={data.cpu.usedPercent}
          onClick={() => setDetail("cpu")}
        />
        <StatCard
          icon={MemoryStick}
          label="Memory"
          value={`${formatBytes(data.memory.usedBytes)} used`}
          detail={`${formatBytes(data.memory.availableBytes)} available of ${formatBytes(data.memory.totalBytes)}`}
          percent={data.memory.usedPercent}
          onClick={() => setDetail("memory")}
        />
        <StatCard
          icon={HardDrive}
          label={`Disk (${data.disk.mount})`}
          value={`${formatBytes(data.disk.usedBytes)} used`}
          detail={`${formatBytes(data.disk.availableBytes)} free of ${formatBytes(data.disk.totalBytes)}`}
          percent={data.disk.usedPercent}
          onClick={() => setDetail("disk")}
        />
        <StatCard
          icon={Timer}
          label="Uptime"
          value={formatUptime(data.uptimeSeconds)}
          detail={`Since ${new Date(Date.now() - data.uptimeSeconds * 1000).toLocaleDateString()}`}
        />
      </div>

      <section className="rounded-2xl border border-white/60 bg-white/70 p-5 shadow-card backdrop-blur-md sm:p-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-bold">Last 24 hours</h3>
          <div className="flex gap-4 text-xs text-slate-500">
            <span>CPU {data.cpu.usedPercent}%</span>
            <span>Memory {data.memory.usedPercent}%</span>
            <span>Disk {data.disk.usedPercent}%</span>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {(["cpu", "memory", "disk"] as Metric[]).map((metric) => (
            <button
              key={metric}
              type="button"
              onClick={() => setDetail(metric)}
              className="rounded-xl border border-slate-200/70 bg-white/60 p-3 text-left transition hover:border-panel-300"
            >
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                {metric === "cpu" ? "CPU" : metric === "memory" ? "Memory" : "Disk"}
              </p>
              <HistoryChart points={history} accessor={metricConfig[metric].accessor} height={80} showAxis={false} />
            </button>
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-white/60 bg-white/70 shadow-card backdrop-blur-md">
        <div className="border-b border-slate-200/70 px-5 py-4">
          <div className="flex items-start gap-3">
            <UsersRound className="mt-0.5 h-5 w-5 text-panel-600" />
            <div>
              <h3 className="font-bold">Website resource usage</h3>
              <p className="mt-0.5 text-sm text-slate-500">
                {data.attribution.memoryMethod === "pss"
                  ? "Shared memory is counted proportionally. "
                  : "The kernel did not expose proportional memory for every process, so memory uses RSS fallback. "}
                Ambiguous processes stay in Shared or System instead of being guessed.
              </p>
            </div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(220px,1fr)_180px_180px_auto]">
            <label className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <Input
                aria-label="Search websites"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search website or site user"
                className="pl-9"
              />
            </label>
            <select
              aria-label="Filter by website type"
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value)}
              className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700"
            >
              <option value="all">All website types</option>
              {websiteTypes.map((type) => <option key={type} value={type}>{type.replace("-", " ")}</option>)}
            </select>
            <select
              aria-label="Sort websites"
              value={sort}
              onChange={(event) => setSort(event.target.value as WebsiteSort)}
              className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700"
            >
              <option value="memory">Highest memory</option>
              <option value="cpu">Highest CPU</option>
              <option value="disk">Highest disk</option>
              <option value="domain">Website name</option>
            </select>
            <label className="flex h-10 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-600">
              <input type="checkbox" checked={activeOnly} onChange={(event) => setActiveOnly(event.target.checked)} />
              Active only
            </label>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b bg-slate-50/70 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-3 font-semibold">Website</th>
                <th className="px-4 py-3 font-semibold">Type</th>
                <th className="px-4 py-3 font-semibold">CPU</th>
                <th className="px-4 py-3 font-semibold">Memory</th>
                <th className="px-4 py-3 font-semibold">Disk</th>
                <th className="px-4 py-3 text-right font-semibold">Processes</th>
              </tr>
              <tr>
                <th className="px-5 pb-2"></th>
                <th className="px-4 pb-2"></th>
                <th className="px-4 pb-2 font-normal normal-case tracking-normal text-[10px] text-slate-400" colSpan={3}>
                  bar &amp; right = share of server capacity · left = share of current server usage
                </th>
                <th className="px-4 pb-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visibleWebsites.map((entry) => (
                <tr key={entry.domain} className="hover:bg-panel-50/30">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-panel-50 text-xs font-bold text-panel-700">
                        {entry.domain.slice(0, 2).toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <p className="max-w-64 truncate font-semibold text-ink">{entry.domain}</p>
                        <p className="truncate text-xs text-slate-400">{entry.siteUser}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold capitalize text-slate-600">
                      {entry.type.replace("-", " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <UsageCell
                      primary={`${entry.cpuPercent}%`}
                      shareOfUsed={(entry.cpuPercent / cpuUsedTotal) * 100}
                      shareOfAvail={(entry.cpuPercent / cpuCapacity) * 100}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <UsageCell
                      primary={formatBytes(entry.memoryBytes)}
                      shareOfUsed={(entry.memoryBytes / memUsedTotal) * 100}
                      shareOfAvail={(entry.memoryBytes / memCapacity) * 100}
                    />
                  </td>
                  <td className="px-4 py-3">
                    {entry.diskBytes != null ? (
                      <div>
                        <UsageCell
                          primary={formatBytes(entry.diskBytes)}
                          shareOfUsed={(entry.diskBytes / diskUsedTotal) * 100}
                          shareOfAvail={(entry.diskBytes / diskCapacity) * 100}
                        />
                        {entry.diskShared && <p className="mt-1 text-[10px] font-medium text-amber-600">shared application root</p>}
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">Measuring…</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-slate-600">{entry.processes}</td>
                </tr>
              ))}
              {!visibleWebsites.length && (
                <tr><td colSpan={7} className="px-5 py-10 text-center text-sm text-slate-400">No websites match these filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-3 text-sm text-slate-500">
          <span>{filteredWebsites.length} website{filteredWebsites.length === 1 ? "" : "s"}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-24 text-center">Page {page} of {pageCount}</span>
            <Button variant="outline" size="icon" aria-label="Next page" disabled={page >= pageCount} onClick={() => setPage((current) => current + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-white/60 bg-white/70 p-5 shadow-card backdrop-blur-md">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">System</p>
          <p className="mt-2 text-sm font-semibold text-slate-700">
            {data.system.cpuPercent}% CPU · {formatBytes(data.system.memoryBytes)} memory · {data.system.processes} processes
          </p>
          <p className="mt-1 text-xs text-slate-500">Host services and processes with no safe website match.</p>
        </div>
        <div className="rounded-2xl border border-white/60 bg-white/70 p-5 shadow-card backdrop-blur-md">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Shared website processes</p>
          <p className="mt-2 text-sm font-semibold text-slate-700">
            {data.shared.cpuPercent}% CPU · {formatBytes(data.shared.memoryBytes)} memory · {data.shared.processes} processes
          </p>
          <p className="mt-1 text-xs text-slate-500">Owned by a site user shared by multiple websites, without enough evidence for an honest split.</p>
        </div>
        <p className="text-xs leading-5 text-slate-400 sm:col-span-2">{data.attribution.note}</p>
      </section>

      {active && detail && createPortal(
        <div
          className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-950/40 backdrop-blur-sm sm:items-center sm:p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDetail(null);
          }}
        >
          <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 sm:px-6">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-panel-50 text-panel-600">
                  <active.icon className="h-5 w-5" />
                </span>
                <div>
                  <h3 className="text-lg font-bold text-ink">{active.title}</h3>
                  <p className="text-xs text-slate-500">Currently at {active.percent}%</p>
                </div>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setDetail(null)} aria-label="Close details">
                <X className="h-5 w-5" />
              </Button>
            </div>
            <div className="space-y-5 overflow-y-auto p-5 sm:p-6">
              <Gauge percent={active.percent} />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {active.facts.map((fact) => (
                  <div key={fact.label} className="rounded-xl border border-slate-200/70 bg-slate-50/60 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{fact.label}</p>
                    <p className="mt-1 truncate text-sm font-bold text-ink">{fact.value}</p>
                  </div>
                ))}
              </div>
              <div>
                <h4 className="mb-2 text-sm font-bold text-slate-700">History (24h)</h4>
                <HistoryChart points={history} accessor={active.accessor} />
              </div>
              {detail === "disk" ? (
                <div>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div>
                      <h4 className="text-sm font-bold text-slate-700">Storage breakdown</h4>
                      <p className="text-xs text-slate-400">Complete filesystem groups, not only website application roots.</p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={storageBusy}
                      onClick={() => void loadStorage(true)}
                    >
                      {storageBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                      Analyze again
                    </Button>
                  </div>
                  {storageBusy && !storage ? (
                    <div className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center">
                      <LoaderCircle className="mx-auto h-5 w-5 animate-spin text-panel-600" />
                      <p className="mt-2 text-sm font-semibold text-slate-600">Analyzing allocated storage…</p>
                      <p className="mt-1 text-xs text-slate-400">Large Docker stores can take a minute or two. Hosted sites continue running normally.</p>
                    </div>
                  ) : storage ? (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {[
                          ["Allocated", formatBytes(storage.usedBytes)],
                          ["Available", formatBytes(storage.availableBytes)],
                          ["Reserved", formatBytes(storage.reservedBytes)],
                          ["Identified", formatBytes(storage.accountedBytes)],
                        ].map(([label, value]) => (
                          <div key={label} className="rounded-lg bg-slate-50 p-2.5">
                            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
                            <p className="mt-0.5 text-xs font-bold text-slate-700">{value}</p>
                          </div>
                        ))}
                      </div>
                      {storage.reservedBytes > 0 && (
                        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                          Reserved space is held by the filesystem and is not ordinary file data.
                        </p>
                      )}
                      {storage.groups.map((group) => (
                        <div key={group.id} className="rounded-xl border border-slate-200/70 p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-ink">{group.label}</p>
                              <p className="mt-0.5 text-xs leading-5 text-slate-400">{group.description}</p>
                            </div>
                            <span className="shrink-0 text-sm font-bold text-slate-700">{formatBytes(group.bytes)}</span>
                          </div>
                          <Gauge percent={(group.bytes / Math.max(1, storage.usedBytes)) * 100} className="mt-2" />
                          {group.details.length > 0 && (
                            <details className="mt-2 border-t border-slate-100 pt-2">
                              <summary className="cursor-pointer text-xs font-semibold text-panel-600">Show details</summary>
                              <div className="mt-2 space-y-2">
                                {group.details.map((entry) => (
                                  <div key={`${group.id}-${entry.label}`} className="rounded-lg bg-slate-50/80 p-2.5">
                                    <div className="flex items-start justify-between gap-3">
                                      <div className="min-w-0">
                                        <p className="break-all text-xs font-semibold text-slate-700">{entry.label}</p>
                                        {entry.note && <p className="mt-0.5 text-[11px] leading-4 text-slate-400">{entry.note}</p>}
                                      </div>
                                      <span className="shrink-0 text-xs font-bold text-slate-600">{formatBytes(entry.bytes)}</span>
                                    </div>
                                    {entry.metrics && entry.metrics.length > 0 && (
                                      <div className="mt-2 grid gap-1 sm:grid-cols-2">
                                        {entry.metrics.map((metric) => (
                                          <p key={metric.label} className="rounded bg-white px-2 py-1 text-[10px] text-slate-500">
                                            <b className="text-slate-700">{metric.label}:</b> {metric.value}
                                            {metric.reclaimable ? ` · reclaimable ${metric.reclaimable}` : ""}
                                          </p>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </details>
                          )}
                        </div>
                      ))}
                      <p className="text-[11px] leading-5 text-slate-400">
                        Updated {new Date(storage.generatedAt).toLocaleString()}. {storage.note}
                      </p>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-red-200 bg-red-50/50 px-4 py-5 text-center">
                      <p className="text-sm font-semibold text-red-700">Storage analysis is unavailable.</p>
                      <p className="mt-1 text-xs text-red-600">{storageError}</p>
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <h4 className="mb-2 text-sm font-bold text-slate-700">Top consumers</h4>
                  {active.consumers.length ? (
                    <div className="space-y-2">
                      {active.consumers.map((consumer) => (
                        <div key={consumer.name} className="rounded-xl border border-slate-200/70 p-3">
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-ink">{consumer.name}</p>
                              <p className="truncate text-xs text-slate-400">{consumer.note}</p>
                            </div>
                            <span className="shrink-0 text-sm font-bold text-slate-700">{consumer.value}</span>
                          </div>
                          <Gauge percent={consumer.percent} className="mt-2" />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="rounded-xl border border-dashed border-slate-200 py-6 text-center text-sm text-slate-400">
                      No measurable usage right now.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
