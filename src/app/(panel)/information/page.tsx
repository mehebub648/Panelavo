import { notFound } from "next/navigation";
import {
  Cpu,
  Globe2,
  HardDrive,
  MemoryStick,
  MonitorCog,
  Server,
  Timer,
} from "lucide-react";
import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";

export const dynamic = "force-dynamic";

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
  return days > 0 ? `${days} days, ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export default async function InformationPage() {
  const session = await requireUser();
  if (!["super-admin", "manager"].includes(session.user.panelRole ?? "")) notFound();
  const info = await getCloudPanelClient().getServerInfo(session.record.cloudPanel);

  const facts = [
    { icon: Server, label: "Hostname", value: info.hostname },
    { icon: Globe2, label: "Public IP", value: info.ip || "unknown" },
    { icon: MonitorCog, label: "Operating system", value: `${info.os} (${info.kernel}, ${info.arch})` },
    { icon: Cpu, label: "Processor", value: `${info.cpuModel} · ${info.cpuCores} cores` },
    { icon: MemoryStick, label: "Memory", value: formatBytes(info.memoryTotalBytes) },
    { icon: HardDrive, label: "Disk", value: formatBytes(info.diskTotalBytes) },
    { icon: Timer, label: "Uptime", value: formatUptime(info.uptimeSeconds) },
  ];

  return (
    <div className="w-full space-y-5">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-ink">Information</h2>
        <p className="mt-1 text-sm text-slate-500">
          Hardware, operating system, and installed software on this server.
        </p>
      </div>

      <section className="rounded-2xl border border-white/60 bg-white/70 p-5 shadow-card backdrop-blur-md sm:p-6">
        <h3 className="font-bold">Server</h3>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {facts.map(({ icon: Icon, label, value }) => (
            <div key={label} className="flex items-start gap-3 rounded-xl border border-slate-200/60 bg-white/60 p-4">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-panel-50 text-panel-600">
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</dt>
                <dd className="mt-0.5 break-words text-sm font-semibold text-ink">{value}</dd>
              </div>
            </div>
          ))}
        </dl>
      </section>

      <section className="overflow-hidden rounded-2xl border border-white/60 bg-white/70 shadow-card backdrop-blur-md">
        <div className="border-b border-slate-200/70 px-5 py-4 sm:px-6">
          <h3 className="font-bold">Installed software</h3>
          <p className="mt-0.5 text-sm text-slate-500">Versions detected on this machine.</p>
        </div>
        <div className="grid gap-px bg-slate-100 sm:grid-cols-2 lg:grid-cols-3">
          {info.software.map((item) => (
            <div key={item.name} className="flex items-center justify-between gap-3 bg-white px-5 py-4">
              <span className="text-sm font-semibold text-slate-700">{item.name}</span>
              <code className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
                {item.version}
              </code>
            </div>
          ))}
          {!info.software.length && (
            <p className="bg-white px-5 py-8 text-sm text-slate-400 sm:col-span-2 lg:col-span-3">
              No software versions could be detected.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
