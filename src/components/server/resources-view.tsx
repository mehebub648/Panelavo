"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Cpu,
  HardDrive,
  LoaderCircle,
  MemoryStick,
  RefreshCw,
  Timer,
  UsersRound,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { ResourceHistoryPoint, ServerResources } from "@/types/cloudpanel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Metric = "cpu" | "memory" | "disk";

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
  initialData: ServerResources;
  initialHistory: ResourceHistoryPoint[];
}) {
  const [data, setData] = useState(initialData);
  const [history, setHistory] = useState(initialHistory);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<Metric | null>(null);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setBusy(true);
    try {
      const result = await fetch("/api/server/resources", { cache: "no-store" }).then((r) => r.json());
      if (!result.success) throw new Error(result.error?.message || "Resources could not be loaded.");
      setData(result.data.resources as ServerResources);
      setHistory((result.data.history ?? []) as ResourceHistoryPoint[]);
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : "Resources could not be loaded.");
    } finally {
      if (!silent) setBusy(false);
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(() => void refresh(true), 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const maxCpu = Math.max(1, ...data.users.map((entry) => entry.cpuPercent));
  const maxMemory = Math.max(1, ...data.users.map((entry) => entry.memoryBytes));
  const maxDisk = Math.max(1, ...data.users.map((entry) => entry.diskBytes ?? 0));

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
      consumers: [...data.users]
        .sort((a, b) => b.cpuPercent - a.cpuPercent)
        .filter((entry) => entry.cpuPercent > 0)
        .slice(0, 10)
        .map((entry) => ({
          name: entry.user,
          note: entry.domains?.join(", ") || `${entry.processes} processes`,
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
      consumers: [...data.users]
        .sort((a, b) => b.memoryBytes - a.memoryBytes)
        .filter((entry) => entry.memoryBytes > 0)
        .slice(0, 10)
        .map((entry) => ({
          name: entry.user,
          note: entry.domains?.join(", ") || `${entry.processes} processes`,
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
      consumers: [...data.users]
        .filter((entry) => (entry.diskBytes ?? 0) > 0)
        .sort((a, b) => (b.diskBytes ?? 0) - (a.diskBytes ?? 0))
        .slice(0, 10)
        .map((entry) => ({
          name: entry.user,
          note: entry.domains?.join(", ") || "home directory",
          value: formatBytes(entry.diskBytes ?? 0),
          percent: ((entry.diskBytes ?? 0) / maxDisk) * 100,
        })),
    },
  }), [data, maxCpu, maxMemory, maxDisk]);

  const active = detail ? metricConfig[detail] : null;

  return (
    <div className="w-full space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-ink">Resources</h2>
          <p className="mt-1 text-sm text-slate-500">
            Live server usage, broken down by application and user. Tap a card for details.
          </p>
        </div>
        <Button variant="outline" onClick={() => void refresh()} disabled={busy}>
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh
        </Button>
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
        <div className="flex items-center gap-3 border-b border-slate-200/70 px-5 py-4">
          <UsersRound className="h-5 w-5 text-panel-600" />
          <div>
            <h3 className="font-bold">Usage by user & application</h3>
            <p className="mt-0.5 text-sm text-slate-500">
              Aggregated from running processes; disk covers each site user&apos;s home directory.
            </p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b bg-slate-50/70 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-3 font-semibold">User / websites</th>
                <th className="px-4 py-3 font-semibold">CPU</th>
                <th className="px-4 py-3 font-semibold">Memory</th>
                <th className="px-4 py-3 font-semibold">Disk</th>
                <th className="px-4 py-3 text-right font-semibold">Processes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.users.map((entry) => (
                <tr key={entry.user} className="hover:bg-panel-50/30">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <span className={cn(
                        "grid h-8 w-8 shrink-0 place-items-center rounded-lg text-xs font-bold",
                        entry.domains?.length ? "bg-panel-50 text-panel-700" : "bg-slate-100 text-slate-500",
                      )}>
                        {entry.user.slice(0, 2).toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <p className="font-semibold text-ink">{entry.user}</p>
                        <p className="truncate text-xs text-slate-400">
                          {entry.domains?.length ? entry.domains.join(", ") : "system"}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="w-28 sm:w-36">
                      <p className="mb-1 text-xs font-medium text-slate-600">{entry.cpuPercent}%</p>
                      <Gauge percent={(entry.cpuPercent / maxCpu) * 100} />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="w-28 sm:w-36">
                      <p className="mb-1 text-xs font-medium text-slate-600">
                        {formatBytes(entry.memoryBytes)} · {entry.memoryPercent}%
                      </p>
                      <Gauge percent={(entry.memoryBytes / maxMemory) * 100} />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {entry.diskBytes !== undefined ? (
                      <div className="w-28 sm:w-36">
                        <p className="mb-1 text-xs font-medium text-slate-600">{formatBytes(entry.diskBytes)}</p>
                        <Gauge percent={(entry.diskBytes / maxDisk) * 100} />
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-slate-600">{entry.processes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
