"use client";

import { useState } from "react";
import {
  Boxes,
  Container,
  Hammer,
  LoaderCircle,
  Package,
  Play,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Square,
  Terminal,
  Trash2,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Pm2Process = { name: string; status: string; cpu: number; memory: number; restarts: number };
export type ActionsData = {
  type?: string;
  path?: string;
  processName?: string;
  hasPackageJson?: boolean;
  scripts?: { name: string; command: string }[];
  hasComposer?: boolean;
  hasArtisan?: boolean;
  hasRequirements?: boolean;
  hasCompose?: boolean;
  hasEcosystem?: boolean;
  pm2Available?: boolean;
  dockerAvailable?: boolean;
  pm2?: Pm2Process[];
  run?: { command: string; display: string; exitCode: number; timedOut?: boolean; output: string };
};

type ActionDef = {
  id: string;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  script?: string;
  danger?: boolean;
};

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

export function ActionsManager({
  domain,
  initialData,
  canRunDocker,
}: {
  domain: string;
  initialData: ActionsData;
  canRunDocker: boolean;
}) {
  const [data, setData] = useState(initialData);
  const [running, setRunning] = useState<string | null>(null);
  const [output, setOutput] = useState<ActionsData["run"] | null>(null);

  async function run(command: string, script?: string) {
    if (running) return;
    setRunning(script ? `${command}:${script}` : command);
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(domain)}/sections/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "run", command, ...(script ? { script } : {}) }),
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error?.message || "The command could not be executed.");
      const next = result.data as ActionsData;
      setData(next);
      setOutput(next.run ?? null);
      if (next.run?.timedOut) toast.error("The command was stopped after its time limit.");
      else if (next.run && next.run.exitCode !== 0) toast.error(`Command finished with exit code ${next.run.exitCode}.`);
      else toast.success("Command completed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The command could not be executed.");
    } finally {
      setRunning(null);
    }
  }

  const groups: { title: string; description: string; show: boolean; actions: ActionDef[] }[] = [
    {
      title: "Dependencies",
      description: "Install what the application needs to run.",
      show: Boolean(data.hasPackageJson || data.hasComposer || data.hasRequirements),
      actions: [
        ...(data.hasPackageJson
          ? [
              { id: "npm-install", label: "npm install", description: "Install Node.js dependencies", icon: Package },
              { id: "npm-ci", label: "npm ci", description: "Clean install from the lockfile", icon: Package },
            ]
          : []),
        ...(data.hasComposer
          ? [
              { id: "composer-install", label: "composer install", description: "Install PHP dependencies", icon: Package },
              { id: "composer-update", label: "composer update", description: "Update PHP dependencies", icon: RefreshCw },
            ]
          : []),
        ...(data.hasRequirements
          ? [{ id: "pip-install", label: "pip install", description: "Install from requirements.txt", icon: Package }]
          : []),
      ],
    },
    {
      title: "Build & scripts",
      description: "Scripts detected in package.json run as the site user.",
      show: Boolean(data.scripts?.length),
      actions: (data.scripts ?? []).slice(0, 12).map((script) => ({
        id: "npm-run",
        script: script.name,
        label: `npm run ${script.name}`,
        description: script.command.length > 60 ? `${script.command.slice(0, 60)}…` : script.command,
        icon: script.name === "build" ? Hammer : Terminal,
      })),
    },
    {
      title: "Process manager (PM2)",
      description: data.hasEcosystem
        ? "An ecosystem.config file was detected — start uses it directly."
        : "Start runs “npm start” under PM2 with this site's name.",
      show: Boolean(data.pm2Available && (data.hasPackageJson || data.hasEcosystem || data.pm2?.length)),
      actions: [
        { id: "pm2-start", label: "Start / reload", description: data.hasEcosystem ? "pm2 startOrReload ecosystem" : `pm2 start npm --name ${data.processName ?? domain}`, icon: Play },
        { id: "pm2-restart", label: "Restart", description: "Restart this site user's processes", icon: RotateCcw },
        { id: "pm2-stop", label: "Stop", description: "Stop this site user's processes", icon: Square },
        { id: "pm2-logs", label: "Logs", description: "Show the last 200 log lines", icon: ScrollText },
        { id: "pm2-save", label: "Save list", description: "Persist processes across reboots", icon: Zap },
        { id: "pm2-delete", label: "Delete all", description: "Remove all processes from PM2", icon: Trash2, danger: true },
      ],
    },
    {
      title: "Laravel",
      description: "Common artisan maintenance commands.",
      show: Boolean(data.hasArtisan),
      actions: [
        { id: "artisan-migrate", label: "Migrate", description: "php artisan migrate --force", icon: Play },
        { id: "artisan-optimize", label: "Clear caches", description: "php artisan optimize:clear", icon: RefreshCw },
        { id: "artisan-storage-link", label: "Storage link", description: "php artisan storage:link", icon: Zap },
      ],
    },
    {
      title: "Docker Compose",
      description: canRunDocker
        ? "A compose file was detected in the site root. Commands run as root."
        : "Docker commands are limited to super admins and managers.",
      show: Boolean(data.hasCompose && data.dockerAvailable),
      actions: canRunDocker
        ? [
            { id: "compose-up", label: "Up", description: "docker compose up -d", icon: Play },
            { id: "compose-restart", label: "Restart", description: "docker compose restart", icon: RotateCcw },
            { id: "compose-pull", label: "Pull", description: "Pull the latest images", icon: RefreshCw },
            { id: "compose-ps", label: "Status", description: "docker compose ps", icon: Boxes },
            { id: "compose-logs", label: "Logs", description: "Last 200 container log lines", icon: ScrollText },
            { id: "compose-down", label: "Down", description: "Stop and remove containers", icon: Square, danger: true },
          ]
        : [],
    },
  ];
  const visible = groups.filter((group) => group.show && group.actions.length);

  return (
    <div className="space-y-5">
      {data.pm2?.length ? (
        <section className="overflow-hidden rounded-2xl border border-white/60 bg-white/70 shadow-card backdrop-blur-md">
          <div className="border-b border-slate-200/70 px-5 py-4">
            <h3 className="font-bold">Running processes</h3>
            <p className="mt-0.5 text-sm text-slate-500">PM2 processes owned by this site user.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-slate-50/70 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-3 font-semibold">Name</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">CPU</th>
                  <th className="px-4 py-3 font-semibold">Memory</th>
                  <th className="px-4 py-3 font-semibold">Restarts</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.pm2.map((proc) => (
                  <tr key={proc.name}>
                    <td className="px-5 py-3 font-medium text-ink">{proc.name}</td>
                    <td className="px-4 py-3">
                      <span className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-semibold",
                        proc.status === "online" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600",
                      )}>
                        {proc.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-500">{proc.cpu}%</td>
                    <td className="px-4 py-3 text-slate-500">{formatBytes(proc.memory)}</td>
                    <td className="px-4 py-3 text-slate-500">{proc.restarts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {visible.map((group) => (
        <section key={group.title} className="rounded-2xl border border-white/60 bg-white/70 p-5 shadow-card backdrop-blur-md sm:p-6">
          <div className="mb-4">
            <h3 className="font-bold">{group.title}</h3>
            <p className="mt-0.5 text-sm text-slate-500">{group.description}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {group.actions.map((action) => {
              const key = action.script ? `${action.id}:${action.script}` : action.id;
              const busy = running === key;
              return (
                <button
                  key={key}
                  type="button"
                  disabled={Boolean(running)}
                  onClick={() => void run(action.id, action.script)}
                  className={cn(
                    "group flex items-start gap-3 rounded-xl border p-4 text-left transition disabled:opacity-60",
                    action.danger
                      ? "border-red-200/70 bg-red-50/40 hover:bg-red-50"
                      : "border-slate-200/70 bg-white/60 hover:border-panel-300 hover:bg-panel-50/40",
                  )}
                >
                  <span className={cn(
                    "grid h-9 w-9 shrink-0 place-items-center rounded-lg",
                    action.danger ? "bg-red-100 text-red-600" : "bg-panel-50 text-panel-600",
                  )}>
                    {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <action.icon className="h-4 w-4" />}
                  </span>
                  <span className="min-w-0">
                    <span className={cn("block truncate text-sm font-semibold", action.danger ? "text-red-700" : "text-ink")}>
                      {action.label}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-slate-500">{action.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}

      {!visible.length && (
        <section className="rounded-2xl border border-dashed border-slate-300 bg-white/60 p-10 text-center">
          <Container className="mx-auto h-10 w-10 text-slate-300" />
          <h3 className="mt-3 font-bold">No actions detected</h3>
          <p className="mt-1 text-sm text-slate-500">
            Add a package.json, composer.json, requirements.txt, or docker-compose.yml to
            <code className="mx-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs">{data.path}</code>
            and the matching actions will appear here.
          </p>
        </section>
      )}

      {output && (
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
            <div className="min-w-0">
              <h3 className="font-bold">Command output</h3>
              <code className="mt-0.5 block truncate text-xs text-slate-500">{output.display}</code>
            </div>
            <span className={cn(
              "shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold",
              output.timedOut ? "bg-amber-50 text-amber-700" : output.exitCode === 0 ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600",
            )}>
              {output.timedOut ? "Timed out" : output.exitCode === 0 ? "Success" : `Exit code ${output.exitCode}`}
            </span>
          </div>
          <pre className="max-h-[50vh] overflow-auto bg-slate-950 p-5 font-mono text-xs leading-5 text-slate-200">
            {output.output || "The command produced no output."}
          </pre>
        </section>
      )}
    </div>
  );
}
