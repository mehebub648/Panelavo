"use client";
import { useState } from "react";
import { Activity, LoaderCircle, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { UptimeConfig, UptimeState } from "@/server/monitoring/store";

export function UptimeSettings({
  domain,
  initial,
  canWrite,
  apiBase = "",
}: {
  domain: string;
  initial: { config: UptimeConfig; state: UptimeState };
  canWrite: boolean;
  apiBase?: string;
}) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const response = await fetch(
        `${apiBase}/api/sites/${encodeURIComponent(domain)}/uptime`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data.config),
        },
      );
      const result = await response.json();
      if (!result.success)
        throw new Error(
          result.error?.message || "Uptime settings could not be saved.",
        );
      setData(result.data);
      toast.success("Uptime check saved");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Uptime settings could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="overflow-hidden rounded-2xl border border-white/40 bg-white/60 shadow-card backdrop-blur-md">
      <div className="flex items-center gap-3 border-b border-slate-200/50 bg-slate-50/40 px-5 py-4 sm:px-6">
        <Activity className="h-5 w-5 text-panel-600" />
        <div>
          <h3 className="font-bold">Uptime monitoring</h3>
          <p className="text-sm text-slate-500">
            Probe the primary HTTPS domain and monitor its certificate.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-4 p-5 sm:p-6">
        <label className="flex h-10 items-center gap-2 text-sm font-semibold">
          <input
            type="checkbox"
            checked={data.config.enabled}
            disabled={!canWrite}
            onChange={(event) =>
              setData((current) => ({
                ...current,
                config: { ...current.config, enabled: event.target.checked },
              }))
            }
          />{" "}
          Enable checks
        </label>
        <label className="text-xs font-semibold text-slate-500">
          Every minutes
          <Input
            className="mt-1 w-28"
            type="number"
            min={1}
            max={60}
            value={data.config.intervalMinutes}
            disabled={!canWrite}
            onChange={(event) =>
              setData((current) => ({
                ...current,
                config: {
                  ...current.config,
                  intervalMinutes: Number(event.target.value),
                },
              }))
            }
          />
        </label>
        {canWrite ? (
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save
          </Button>
        ) : null}
        <span
          className={`rounded-full px-3 py-1 text-xs font-bold ${data.state.status === "up" ? "bg-emerald-50 text-emerald-700" : data.state.status === "down" ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-500"}`}
        >
          {data.state.status.toUpperCase()}
        </span>
        {data.state.lastCheckAt ? (
          <span className="text-xs text-slate-400">
            Last checked {new Date(data.state.lastCheckAt).toLocaleString()}
          </span>
        ) : null}
      </div>
    </section>
  );
}
