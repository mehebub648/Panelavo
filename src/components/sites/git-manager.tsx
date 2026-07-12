"use client";

import { useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Check, FileDiff, GitBranch, GitCommit, GitFork, LoaderCircle, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type GitChange = { status: string; path: string; originalPath?: string };
type GitData = {
  isRepository: boolean; path: string; branch?: string; head?: string; remotes?: string[][]; branches?: string[];
  changes?: GitChange[]; commits?: { hash: string; author: string; date: string; subject: string }[];
  selectedDiff?: { path: string; diff: string }; notice?: string;
};
type ConfirmState = { kind: "file"; change: GitChange } | { kind: "all" } | null;

export function GitManager({ domain, initialData }: { domain: string; initialData: GitData }) {
  const [data, setData] = useState(initialData);
  const [busy, setBusy] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState>(null);

  async function action(input: Record<string, unknown>, message?: string) {
    setBusy(true);
    try {
      const result = await fetch(`/api/sites/${encodeURIComponent(domain)}/sections/git`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      }).then((response) => response.json());
      if (!result.success) throw new Error(result.error?.message || "Git operation failed");
      setData(result.data);
      if (result.data.notice) toast.warning(result.data.notice);
      else if (message) toast.success(message);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Git operation failed");
      return false;
    } finally { setBusy(false); }
  }

  if (!data.isRepository) return <section className="rounded-2xl border border-slate-200 bg-white p-8 shadow-card"><div className="mx-auto max-w-2xl text-center"><GitFork className="mx-auto h-12 w-12 text-panel-500" /><h3 className="mt-4 text-xl font-bold">Connect a Git repository</h3><p className="mt-2 text-sm text-slate-500">Clone into an empty site directory, or initialize Git around files already here.</p></div><form className="mx-auto mt-7 max-w-2xl space-y-4 rounded-xl bg-slate-50 p-5" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void action({ action: "clone", url: form.get("url"), branch: form.get("branch") }, "Repository cloned"); }}><div><Label>Repository URL</Label><Input name="url" placeholder="git@github.com:owner/repository.git" required /></div><div><Label>Branch (optional)</Label><Input name="branch" placeholder="main" /></div><Button disabled={busy}>{busy && <LoaderCircle className="h-4 w-4 animate-spin" />} Clone repository</Button><p className="text-xs text-slate-500">SSH URLs use this site user&apos;s deployment key. The directory must be empty.</p></form><div className="mx-auto mt-5 flex max-w-2xl items-center gap-3"><span className="h-px flex-1 bg-slate-200" /><span className="text-xs text-slate-400">or keep existing files</span><span className="h-px flex-1 bg-slate-200" /></div><div className="mt-5 text-center"><Button variant="outline" disabled={busy} onClick={() => void action({ action: "init" }, "Repository initialized")}>Initialize existing directory</Button></div></section>;

  const origin = data.remotes?.find((remote) => remote[0] === "origin" && remote[2] === "(fetch)")?.[1];
  const changes = data.changes ?? [];
  return <div className="space-y-5">
    <section className="rounded-2xl border bg-white p-5 shadow-card"><div className="flex flex-wrap items-center justify-between gap-4"><div><div className="flex items-center gap-3"><GitBranch className="h-5 w-5 text-panel-600" /><h3 className="font-bold">{data.branch || "Detached HEAD"}</h3><code className="rounded bg-slate-100 px-2 py-1 text-xs">{data.head || "No commits"}</code></div><p className="mt-2 text-xs text-slate-500">{origin || "No origin remote configured"}</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => setRemoteOpen(true)}>Remote</Button><Button variant="outline" size="sm" disabled={busy || !origin} onClick={() => void action({ action: "fetch" }, "Remote fetched")}><RefreshCw className="h-4 w-4" /> Fetch</Button><Button variant="outline" size="sm" disabled={busy || !origin} onClick={() => void action({ action: "pull", branch: data.branch }, "Pulled latest changes")}><ArrowDownToLine className="h-4 w-4" /> Pull</Button><Button size="sm" disabled={busy || !origin} onClick={() => void action({ action: "push", branch: data.branch }, "Changes pushed")}><ArrowUpFromLine className="h-4 w-4" /> Push</Button></div></div></section>
    <div className="grid gap-5 lg:grid-cols-[1fr_420px]"><section className="rounded-2xl border bg-white shadow-card"><div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4"><div><h3 className="font-bold">Working tree</h3><p className="text-xs text-slate-500">{changes.length} changed files · select a file to view its diff</p></div><div className="flex gap-2">{changes.length > 0 && <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirm({ kind: "all" })}><Trash2 className="h-4 w-4" /> Discard all</Button>}<Button size="sm" disabled={!changes.length || busy} onClick={() => setCommitOpen(true)}><GitCommit className="h-4 w-4" /> Commit</Button></div></div>{changes.length ? <div className="divide-y">{changes.map((change) => <div key={`${change.status}:${change.path}`} className="group flex items-center gap-2 px-3 py-1.5"><button disabled={busy} onClick={() => void action({ action: "diff", path: change.path })} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left text-sm hover:bg-slate-50 disabled:opacity-60"><FileDiff className="h-4 w-4 shrink-0 text-slate-400" /><code className="w-7 shrink-0 text-amber-600">{change.status}</code><span className="truncate">{change.originalPath ? `${change.originalPath} → ${change.path}` : change.path}</span></button><Button title={`Discard changes in ${change.path}`} aria-label={`Discard changes in ${change.path}`} variant="ghost" size="icon" disabled={busy} onClick={() => setConfirm({ kind: "file", change })}><RotateCcw className="h-4 w-4" /></Button></div>)}</div> : <div className="p-10 text-center text-sm text-slate-400"><Check className="mx-auto mb-2 h-6 w-6 text-emerald-500" />Working tree is clean</div>}</section><section className="rounded-2xl border bg-white shadow-card"><div className="border-b px-5 py-4"><h3 className="font-bold">Branches</h3></div><div className="p-3">{data.branches?.map((branch) => <button key={branch} disabled={branch === data.branch || busy} onClick={() => void action({ action: "checkout", branch }, `Switched to ${branch}`)} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm ${branch === data.branch ? "bg-panel-50 font-semibold text-panel-700" : "hover:bg-slate-50"}`}><GitBranch className="h-4 w-4" />{branch}</button>)}</div></section></div>
    <section className="rounded-2xl border bg-white shadow-card"><div className="border-b px-5 py-4"><h3 className="font-bold">Recent commits</h3></div><div className="divide-y">{data.commits?.map((commit) => <div key={commit.hash} className="grid gap-1 px-5 py-3 sm:grid-cols-[90px_1fr_220px]"><code className="text-panel-600">{commit.hash}</code><span className="text-sm font-medium">{commit.subject}</span><span className="text-xs text-slate-400">{commit.author} · {commit.date}</span></div>)}</div></section>
    {data.selectedDiff && <DiffModal value={data.selectedDiff} close={() => setData((current) => ({ ...current, selectedDiff: undefined }))} />}
    {remoteOpen && <Modal title="Origin remote" close={() => setRemoteOpen(false)}><form className="space-y-4" onSubmit={async (event) => { event.preventDefault(); const url = String(new FormData(event.currentTarget).get("url")); if (await action({ action: "set-remote", url }, "Remote updated")) setRemoteOpen(false); }}><div><Label>Git URL</Label><Input name="url" defaultValue={origin} placeholder="git@github.com:owner/repository.git" required /></div><p className="text-xs text-slate-500">SSH remotes use the deployment key shown under SSH/FTP.</p><Button disabled={busy}>Save remote</Button></form></Modal>}
    {commitOpen && <Modal title="Commit changes" close={() => setCommitOpen(false)}><form className="space-y-4" onSubmit={async (event) => { event.preventDefault(); const message = String(new FormData(event.currentTarget).get("message")); if (await action({ action: "commit", message }, "Changes committed")) setCommitOpen(false); }}><div><Label>Commit message</Label><Input name="message" autoFocus required /></div><Button disabled={busy}>Commit all changes</Button></form></Modal>}
    {confirm && <ConfirmDialog title={confirm.kind === "all" ? "Discard all changes?" : `Discard changes in ${confirm.change.path}?`} message="This permanently removes the selected uncommitted work, including untracked files. This action cannot be undone." confirmText={confirm.kind === "all" ? "Discard all" : "Discard file"} onCancel={() => setConfirm(null)} onConfirm={() => { const pending = confirm; setConfirm(null); void action(pending.kind === "all" ? { action: "discard-all" } : { action: "discard", path: pending.change.path }, pending.kind === "all" ? "All changes discarded" : "File changes discarded"); }} />}
  </div>;
}

type DiffRow = { oldNumber?: number; newNumber?: number; oldText?: string; newText?: string; oldKind?: "delete"; newKind?: "add" };
function parseDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  const lines = diff.split("\n");
  let oldNumber = 0, newNumber = 0, index = 0;
  while (index < lines.length) {
    const header = lines[index].match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (!header) { index++; continue; }
    oldNumber = Number(header[1]); newNumber = Number(header[2]); index++;
    while (index < lines.length && !lines[index].startsWith("@@ ")) {
      if (lines[index].startsWith("-")) {
        const deleted: { number: number; text: string }[] = [];
        const added: { number: number; text: string }[] = [];
        while (index < lines.length && lines[index].startsWith("-")) deleted.push({ number: oldNumber++, text: lines[index++].slice(1) });
        while (index < lines.length && lines[index].startsWith("+")) added.push({ number: newNumber++, text: lines[index++].slice(1) });
        for (let pair = 0; pair < Math.max(deleted.length, added.length); pair++) rows.push({ oldNumber: deleted[pair]?.number, oldText: deleted[pair]?.text, oldKind: deleted[pair] ? "delete" : undefined, newNumber: added[pair]?.number, newText: added[pair]?.text, newKind: added[pair] ? "add" : undefined });
      } else if (lines[index].startsWith("+")) {
        rows.push({ newNumber: newNumber++, newText: lines[index].slice(1), newKind: "add" }); index++;
      } else if (lines[index].startsWith(" ")) {
        const text = lines[index].slice(1); rows.push({ oldNumber: oldNumber++, newNumber: newNumber++, oldText: text, newText: text }); index++;
      } else index++;
    }
  }
  return rows;
}
function DiffModal({ value, close }: { value: { path: string; diff: string }; close: () => void }) {
  const rows = parseDiff(value.diff);
  return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/50 p-3"><div className="flex h-[90vh] w-full max-w-[96rem] flex-col overflow-hidden rounded-xl bg-white shadow-2xl"><div className="flex items-center justify-between border-b px-4 py-3"><div className="min-w-0"><h3 className="truncate font-semibold">{value.path}</h3><p className="text-xs text-slate-500">Side-by-side uncommitted changes</p></div><Button variant="ghost" size="icon" onClick={close} aria-label="Close diff"><X className="h-5 w-5" /></Button></div><div className="grid grid-cols-2 border-b bg-slate-50 text-xs font-medium text-slate-500"><div className="border-r px-4 py-2">Original</div><div className="px-4 py-2">Working tree</div></div><div className="min-h-0 flex-1 overflow-auto bg-white font-mono text-xs">{rows.length ? rows.map((row, index) => <div key={index} className="grid min-w-[900px] grid-cols-2"><DiffCell number={row.oldNumber} text={row.oldText} kind={row.oldKind} /><DiffCell number={row.newNumber} text={row.newText} kind={row.newKind} /></div>) : <div className="grid h-full place-items-center p-8 text-sm text-slate-500">No text diff is available for this file. It may be binary or unchanged.</div>}</div></div></div>;
}
function DiffCell({ number, text, kind }: { number?: number; text?: string; kind?: "add" | "delete" }) {
  return <div className={`grid min-h-5 grid-cols-[3.5rem_1fr] border-r ${kind === "add" ? "bg-emerald-50" : kind === "delete" ? "bg-red-50" : ""}`}><span className="select-none border-r px-2 text-right text-slate-400">{number}</span><pre className="whitespace-pre px-2">{text ?? ""}</pre></div>;
}
function Modal({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) { return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4"><div className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl"><div className="mb-5 flex justify-between"><h3 className="text-lg font-bold">{title}</h3><button onClick={close}>×</button></div>{children}</div></div>; }
