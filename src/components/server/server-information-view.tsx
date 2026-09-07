import React from "react";
import {
  Cpu,
  Globe2,
  HardDrive,
  Link2,
  MemoryStick,
  MonitorCog,
  Network,
  Server,
  ShieldCheck,
  Timer,
  TriangleAlert,
} from "lucide-react";
import { CopyValue } from "@/components/ui/copy-value";
import type { ServerInformation } from "@/types/cloudpanel";

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return days > 0
    ? `${days} days, ${hours}h`
    : hours > 0
      ? `${hours}h ${minutes}m`
      : `${minutes}m`;
}

export function ServerInformationView({ info }: { info: ServerInformation }) {
  // Older connected panels can briefly return the pre-v0.1.129 shape during a
  // rolling update. Preserve a useful page until that peer is upgraded.
  const ipv4Addresses = info.ipv4Addresses ?? (info.ip ? [info.ip] : []);
  const ipv6Addresses = info.ipv6Addresses ?? [];
  const facts = [
    { icon: Server, label: "Hostname", value: info.hostname },
    {
      icon: Link2,
      label: "Panel address",
      value: info.panelAddress || "Not configured",
    },
    {
      icon: Globe2,
      label: "IPv4 address",
      value: ipv4Addresses.join(", ") || "Not available",
    },
    {
      icon: Network,
      label: "IPv6 address",
      value: ipv6Addresses.join(", ") || "Not available",
    },
    { icon: MonitorCog, label: "Operating system", value: info.os },
    { icon: MonitorCog, label: "Kernel", value: info.kernel },
    { icon: Cpu, label: "Architecture", value: info.arch },
    {
      icon: Cpu,
      label: "Processor",
      value: `${info.cpuModel} · ${info.cpuCores} cores`,
    },
    {
      icon: MemoryStick,
      label: "Memory",
      value: formatBytes(info.memoryTotalBytes),
    },
    {
      icon: HardDrive,
      label: "Disk capacity",
      value: formatBytes(info.diskTotalBytes),
    },
    { icon: Timer, label: "Uptime", value: formatUptime(info.uptimeSeconds) },
  ];

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-white/60 bg-white/70 p-5 shadow-card backdrop-blur-md sm:p-6">
        <div>
          <h3 className="font-bold">Server details</h3>
          <p className="mt-0.5 text-sm text-slate-500">
            Select any value to copy it.
          </p>
        </div>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {facts.map(({ icon: Icon, label, value }) => (
            <div
              key={label}
              className="flex min-w-0 items-start gap-3 rounded-xl border border-slate-200/60 bg-white/60 p-4"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-panel-50 text-panel-600">
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {label}
                </dt>
                <dd className="mt-0.5 text-sm font-semibold text-ink">
                  <CopyValue value={value} className="break-all px-1 py-0.5">
                    {value}
                  </CopyValue>
                </dd>
              </div>
            </div>
          ))}
        </dl>
      </section>

      {info.maintenance ? (
        <section className="rounded-2xl border border-white/60 bg-white/70 p-5 shadow-card backdrop-blur-md sm:p-6">
          <div className="flex items-start gap-3">
            <span
              className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${
                info.maintenance.status === "current"
                  ? "bg-emerald-50 text-emerald-600"
                  : "bg-amber-50 text-amber-600"
              }`}
            >
              {info.maintenance.status === "current" ? (
                <ShieldCheck className="h-5 w-5" />
              ) : (
                <TriangleAlert className="h-5 w-5" />
              )}
            </span>
            <div>
              <h3 className="font-bold">Operating-system maintenance</h3>
              <p className="mt-1 text-sm text-slate-600">
                {info.maintenance.rebootRequired
                  ? "A reboot is required to finish installed updates."
                  : info.maintenance.securityUpdates > 0
                    ? `${info.maintenance.securityUpdates} security update${info.maintenance.securityUpdates === 1 ? " is" : "s are"} waiting to install.`
                    : "No security updates are waiting to install."}
              </p>
              <p className="mt-2 text-xs text-slate-500">
                {info.maintenance.availableUpdates} total package update
                {info.maintenance.availableUpdates === 1 ? "" : "s"} · Automatic
                security updates{" "}
                {info.maintenance.unattendedUpgrades ? "on" : "off"}
                {info.maintenance.lastPackageIndexAt
                  ? ` · Package list checked ${new Date(info.maintenance.lastPackageIndexAt).toLocaleString()}`
                  : ""}
              </p>
            </div>
          </div>
        </section>
      ) : null}

      <section className="overflow-hidden rounded-2xl border border-white/60 bg-white/70 shadow-card backdrop-blur-md">
        <div className="border-b border-slate-200/70 px-5 py-4 sm:px-6">
          <h3 className="font-bold">Installed software</h3>
          <p className="mt-0.5 text-sm text-slate-500">
            Select a version to copy it.
          </p>
        </div>
        <div className="grid gap-px bg-slate-100 sm:grid-cols-2 lg:grid-cols-3">
          {(info.software ?? []).map((item) => (
            <div
              key={item.name}
              className="flex items-center justify-between gap-3 bg-white px-5 py-4"
            >
              <span className="text-sm font-semibold text-slate-700">
                {item.name}
              </span>
              <CopyValue value={item.version}>
                <code className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
                  {item.version}
                </code>
              </CopyValue>
            </div>
          ))}
          {!info.software?.length && (
            <p className="bg-white px-5 py-8 text-sm text-slate-400 sm:col-span-2 lg:col-span-3">
              No software versions could be detected.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
