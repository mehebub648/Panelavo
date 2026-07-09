"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Cpu,
  HardDrive,
  LoaderCircle,
  MemoryStick,
  RefreshCw,
  Timer,
  UsersRound,
} from "lucide-react";
import { toast } from "sonner";
import type { ServerResources } from "@/types/cloudpanel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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

function StatCard({
  icon: Icon,
  label,
  value,
  detail,
  percent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  detail: string;
  percent?: number;
}) {
  return (
    <section className="rounded-2xl border border-white/60 bg-white/70 p-5 shadow-card backdrop-blur-md">
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
      <p className="mt-1 text-xl font-bold text-ink">{value}</p>
      <p className="mt-0.5 truncate text-xs text-slate-500">{detail}</p>
      {percent !== undefined && <Gauge percent={percent} className="mt-3" />}
    </section>
  );
}

export function ResourcesView({ initialData }: { initialData: ServerResources }) {
  const [data, setData] = useState(initialData);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setBusy(true);
    try {
      const result = await fetch("/api/server/resources", { cache: "no-store" }).then((r) => r.json());
      if (!result.success) throw new Error(result.error?.message || "Resources could not be loaded.");
      setData(result.data.resources as ServerResources);
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

  return (
    <div className="w-full space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-ink">Resources</h2>
          <p className="mt-1 text-sm text-slate-500">
            Live server usage, broken down by application and user. Updated{" "}
            {new Date(data.generatedAt).toLocaleTimeString()}.
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
        />
        <StatCard
          icon={MemoryStick}
          label="Memory"
          value={`${formatBytes(data.memory.usedBytes)} used`}
          detail={`${formatBytes(data.memory.availableBytes)} available of ${formatBytes(data.memory.totalBytes)}${data.swap.totalBytes ? ` · swap ${formatBytes(data.swap.usedBytes)}/${formatBytes(data.swap.totalBytes)}` : ""}`}
          percent={data.memory.usedPercent}
        />
        <StatCard
          icon={HardDrive}
          label={`Disk (${data.disk.mount})`}
          value={`${formatBytes(data.disk.usedBytes)} used`}
          detail={`${formatBytes(data.disk.availableBytes)} free of ${formatBytes(data.disk.totalBytes)}`}
          percent={data.disk.usedPercent}
        />
        <StatCard
          icon={Timer}
          label="Uptime"
          value={formatUptime(data.uptimeSeconds)}
          detail={`Since ${new Date(Date.now() - data.uptimeSeconds * 1000).toLocaleDateString()}`}
        />
      </div>

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
    </div>
  );
}
