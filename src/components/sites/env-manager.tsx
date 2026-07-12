"use client";

import { useMemo, useState } from "react";
import {
  CheckCircle2,
  Eye,
  EyeOff,
  FileCog,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type EnvEntry = { key: string; value: string };
export type EnvFileData = { name: string; exists: boolean; entries: EnvEntry[] };
export type EnvSectionData = {
  path: string;
  files: EnvFileData[];
  userEnv: EnvEntry[];
  profilePath: string;
};

type Row = { id: number; key: string; value: string };

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
let rowId = 0;

function toRows(entries: EnvEntry[]): Row[] {
  return entries.map((entry) => ({ id: ++rowId, ...entry }));
}

function defaultFile(data: EnvSectionData) {
  return data.files.find((file) => file.exists)?.name ?? ".env";
}

export function EnvManager({
  domain,
  initialData,
  canWrite,
}: {
  domain: string;
  initialData: EnvSectionData;
  canWrite: boolean;
}) {
  const [data, setData] = useState(initialData);
  const [file, setFile] = useState(() => defaultFile(initialData));
  const [rows, setRows] = useState<Row[]>(() =>
    toRows(initialData.files.find((item) => item.name === defaultFile(initialData))?.entries ?? []),
  );
  const [showValues, setShowValues] = useState(false);
  const [syncProfile, setSyncProfile] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  const selected = data.files.find((item) => item.name === file);
  const userEnv = useMemo(
    () => new Map(data.userEnv.map((entry) => [entry.key, entry.value])),
    [data.userEnv],
  );
  const savedKeys = useMemo(
    () => new Set((selected?.entries ?? []).map((entry) => entry.key)),
    [selected],
  );
  const duplicates = useMemo(() => {
    const seen = new Set<string>();
    const found = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.key)) found.add(row.key);
      seen.add(row.key);
    }
    return found;
  }, [rows]);
  const invalid = rows.some((row) => !KEY_PATTERN.test(row.key)) || duplicates.size > 0;
  const profileOnly = data.userEnv.filter((entry) => !savedKeys.has(entry.key));

  function selectFile(name: string) {
    if (busy) return;
    setFile(name);
    setRows(toRows(data.files.find((item) => item.name === name)?.entries ?? []));
    setDirty(false);
  }

  function edit(id: number, patch: Partial<Row>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    setDirty(true);
  }

  async function save() {
    if (busy || invalid) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(domain)}/sections/env`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "save",
          file,
          entries: rows.map(({ key, value }) => ({ key, value })),
          syncProfile: file === ".env" ? syncProfile : false,
        }),
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error?.message || "The environment could not be saved.");
      const next = result.data as EnvSectionData;
      setData(next);
      setRows(toRows(next.files.find((item) => item.name === file)?.entries ?? []));
      setDirty(false);
      toast.success(`${file} saved${file === ".env" && syncProfile ? " and synced to the user environment" : ""}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The environment could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  // Sync verdict against the managed block in the site user's ~/.profile —
  // only meaningful for the primary .env, which is the file that mirrors.
  function syncState(row: Row): { label: string; className: string } | null {
    if (file !== ".env" || !KEY_PATTERN.test(row.key)) return null;
    if (!savedKeys.has(row.key)) return { label: "Unsaved", className: "bg-slate-100 text-slate-500" };
    if (!userEnv.has(row.key)) return { label: "File only", className: "bg-amber-50 text-amber-700" };
    return userEnv.get(row.key) === row.value
      ? { label: "Synced", className: "bg-emerald-50 text-emerald-700" }
      : { label: "Out of sync", className: "bg-amber-50 text-amber-700" };
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-white/40 bg-white/60 shadow-card backdrop-blur-md">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200/50 bg-slate-50/40 px-5 py-4 sm:px-6">
        <div className="flex gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-panel-50 text-panel-600">
            <FileCog className="h-5 w-5" />
          </span>
          <div>
            <h3 className="font-bold">Environment</h3>
            <p className="mt-0.5 text-sm text-slate-500">
              Auto-detected dotenv files in <code className="text-xs">{data.path}</code>, kept in
              sync with the site user&apos;s environment.
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setShowValues((current) => !current)}
        >
          {showValues ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          {showValues ? "Hide values" : "Show values"}
        </Button>
      </div>

      <div className="space-y-4 p-5 sm:p-6">
        <div className="flex flex-wrap gap-2">
          {data.files.map((item) => (
            <button
              key={item.name}
              type="button"
              disabled={busy}
              onClick={() => selectFile(item.name)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-semibold transition",
                file === item.name
                  ? "border-panel-300 bg-panel-50 text-panel-700"
                  : "border-slate-200 bg-white/70 text-slate-500 hover:bg-slate-50",
              )}
            >
              {item.name}
              {!item.exists && <span className="ml-1.5 font-normal text-slate-400">(new)</span>}
            </button>
          ))}
        </div>

        <div className="space-y-2">
          {rows.map((row) => {
            const badKey = !KEY_PATTERN.test(row.key) || duplicates.has(row.key);
            const sync = syncState(row);
            return (
              <div key={row.id} className="flex flex-wrap items-center gap-2">
                <Input
                  value={row.key}
                  disabled={!canWrite || busy}
                  onChange={(event) => edit(row.id, { key: event.target.value })}
                  placeholder="KEY"
                  aria-label="Variable name"
                  className={cn(
                    "w-full font-mono text-xs sm:w-56",
                    badKey && "border-red-300 focus:ring-red-400",
                  )}
                />
                <Input
                  value={row.value}
                  type={showValues ? "text" : "password"}
                  disabled={!canWrite || busy}
                  onChange={(event) => edit(row.id, { value: event.target.value })}
                  placeholder="value"
                  aria-label={`Value for ${row.key || "variable"}`}
                  className="min-w-40 flex-1 font-mono text-xs"
                  autoComplete="off"
                />
                {sync && (
                  <span className={cn("rounded-full px-2 py-1 text-[11px] font-semibold", sync.className)}>
                    {sync.label}
                  </span>
                )}
                {canWrite && (
                  <button
                    type="button"
                    aria-label={`Remove ${row.key || "variable"}`}
                    disabled={busy}
                    className="rounded-lg p-2 opacity-60 transition hover:bg-red-50 hover:opacity-100"
                    onClick={() => {
                      setRows((current) => current.filter((item) => item.id !== row.id));
                      setDirty(true);
                    }}
                  >
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </button>
                )}
              </div>
            );
          })}
          {!rows.length && (
            <div className="rounded-xl border border-dashed border-slate-200 py-7 text-center text-sm text-slate-400">
              {selected?.exists
                ? "This file has no variables yet."
                : `${file} does not exist yet — add a variable and save to create it.`}
            </div>
          )}
          {duplicates.size > 0 && (
            <p className="flex items-center gap-2 text-xs font-medium text-red-600">
              <TriangleAlert className="h-3.5 w-3.5" /> Duplicate keys: {[...duplicates].join(", ")}
            </p>
          )}
        </div>

        {profileOnly.length > 0 && file === ".env" && (
          <div className="rounded-xl border border-amber-200/70 bg-amber-50/50 p-3 text-xs text-amber-800">
            <span className="font-bold">Only in the user environment:</span>{" "}
            {profileOnly.map((entry) => entry.key).join(", ")} — saving .env with sync enabled
            replaces the managed block, removing them.
          </div>
        )}

        {canWrite && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200/60 pt-4">
            <div className="flex flex-wrap items-center gap-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setRows((current) => [...current, { id: ++rowId, key: "", value: "" }]);
                  setDirty(true);
                }}
              >
                <Plus className="h-4 w-4" /> Add variable
              </Button>
              {file === ".env" && (
                <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={syncProfile}
                    disabled={busy}
                    onChange={(event) => setSyncProfile(event.target.checked)}
                  />
                  <RefreshCw className="h-3.5 w-3.5 text-slate-400" />
                  Sync to user environment ({data.profilePath})
                </label>
              )}
            </div>
            <div className="flex items-center gap-3">
              {dirty ? (
                <span className="flex items-center gap-1.5 text-xs font-medium text-amber-600">
                  <span className="h-2 w-2 rounded-full bg-amber-500" /> Unsaved changes
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Saved
                </span>
              )}
              <Button type="button" disabled={busy || invalid || !dirty} onClick={() => void save()}>
                {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save {file}
              </Button>
            </div>
          </div>
        )}

        <p className="text-xs leading-5 text-slate-400">
          Applications that read {file} pick changes up on their next restart. Variables from .env
          are also exported to the site user&apos;s login environment (SSH, terminal, cron) and
          injected into PM2 launches from Operations, so the app does not have to parse .env
          itself. Restart the application from Operations to apply changes to a running process.
        </p>
      </div>
    </section>
  );
}
