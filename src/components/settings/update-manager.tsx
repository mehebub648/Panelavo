"use client";

import { useEffect, useState } from "react";
import { DownloadCloud, LoaderCircle, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { UpdateState } from "@/server/updates/panel-updater";

export function UpdateManager({ initialState }: { initialState: UpdateState }) {
  const [state, setState] = useState(initialState);
  const [repository, setRepository] = useState(initialState.repository);
  const [busy, setBusy] = useState<"check" | "save" | "update" | null>(null);
  const running = state.status === "queued" || state.status === "updating";
  const current = Boolean(state.installedCommit && state.remoteCommit && state.installedCommit === state.remoteCommit);

  async function call(url: string, init?: RequestInit) {
    const response = await fetch(url, init); const body = await response.json();
    if (!body.success) throw new Error(body.error?.message || "Update operation failed.");
    setState(body.data); return body.data as UpdateState;
  }
  async function check() {
    setBusy("check"); try { await call("/api/updates?check=true"); } catch (error) { toast.error(error instanceof Error ? error.message : "Update check failed."); } finally { setBusy(null); }
  }
  async function save() {
    setBusy("save"); try {
      await call("/api/updates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "save-repository", repository }) });
      toast.success("Update repository saved.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not save repository."); } finally { setBusy(null); }
  }
  async function update() {
    setBusy("update"); try {
      await call("/api/updates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "update" }) });
      toast.success("Update started. Panelavo will reload when the staged build is ready.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not start update."); } finally { setBusy(null); }
  }
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { void call("/api/updates").catch(() => undefined); }, 3000);
    return () => clearInterval(timer);
  }, [running]);

  const short = (value?: string) => value ? value.slice(0, 10) : "unknown";
  return <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/60 px-5 py-4 sm:px-6">
      <div><h3 className="font-bold">Panel updates</h3><p className="text-sm text-slate-500">Stage, build, and deploy Panelavo without restarting hosted websites.</p></div>
      <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase text-slate-600">{state.status}</span>
    </div>
    <div className="space-y-4 p-5 sm:p-6">
      <div><label className="mb-1.5 block text-sm font-medium text-slate-700">Public update repository</label>
        <div className="flex flex-col gap-2 sm:flex-row"><Input value={repository} onChange={(event) => setRepository(event.target.value)} /><Button variant="outline" disabled={!!busy || repository === state.repository} onClick={() => void save()}>{busy === "save" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save</Button></div>
        <p className="mt-1.5 text-xs text-slate-500">HTTPS public Git repository, main branch. Changing it changes the trusted source of Panelavo code.</p>
      </div>
      <dl className="grid gap-3 rounded-xl bg-slate-50 p-4 text-sm sm:grid-cols-3"><div><dt className="text-slate-500">Installed version</dt><dd className="font-semibold">v{state.currentVersion}</dd></div><div><dt className="text-slate-500">Installed commit</dt><dd className="font-mono">{short(state.installedCommit)}</dd></div><div><dt className="text-slate-500">Latest commit</dt><dd className="font-mono">{short(state.remoteCommit)}</dd></div></dl>
      {state.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{state.error}</p>}
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!!busy || running} onClick={() => void check()}>{busy === "check" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Check for updates</Button><Button disabled={!!busy || running || current} onClick={() => void update()}>{running || busy === "update" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <DownloadCloud className="h-4 w-4" />} {running ? "Updating…" : current ? "Up to date" : "Install latest"}</Button></div>
      <p className="text-xs text-slate-500">The update is built in a staging directory first. Runtime data and environment secrets are preserved. Panelavo reloads briefly; managed websites continue running.</p>
    </div>
  </section>;
}
