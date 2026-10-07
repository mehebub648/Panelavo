"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  FileDiff,
  GitBranch,
  GitCommit,
  GitFork,
  GitMerge,
  History,
  Link2,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import {
  DeploymentManager,
  DeploymentOutput,
} from "@/components/sites/deployment-manager";
import { DeploymentKey } from "@/components/sites/deployment-key";
import type { GitChange, GitData, GitGraphCommit } from "@/types/git";

const tabs = [
  { id: "deployment", label: "Deployment" },
  { id: "changes", label: "Changes" },
  { id: "branches", label: "Branches" },
  { id: "history", label: "History" },
  { id: "connection", label: "Connection & Recovery" },
] as const;
type GitTab = (typeof tabs)[number]["id"];
type ConfirmState =
  | { kind: "file"; change: GitChange }
  | { kind: "all" }
  | { kind: "checkout"; branch: string }
  | { kind: "merge"; branch: string }
  | { kind: "resolve"; path: string; choice: "ours" | "theirs" }
  | {
      kind: "abort";
      operation: Exclude<GitData["state"], undefined>["operation"];
    }
  | null;

function queryTab(): GitTab {
  if (typeof window === "undefined") return "deployment";
  const value = new URL(window.location.href).searchParams.get("gitTab");
  return tabs.some((item) => item.id === value)
    ? (value as GitTab)
    : "deployment";
}

function recoveryFor(message: string): { tab: GitTab; detail: string } {
  if (/auth|publickey|permission denied|credential/i.test(message))
    return {
      tab: "connection",
      detail:
        "Review the origin URL and add this website's deployment key to the repository, then retry.",
    };
  if (/dirty|local changes|working tree|uncommitted/i.test(message))
    return {
      tab: "changes",
      detail: "Commit the listed changes or discard them explicitly.",
    };
  if (/conflict|unresolved|continue|abort/i.test(message))
    return {
      tab: "connection",
      detail:
        "Resolve every listed conflict in Recovery, then continue or abort the active operation.",
    };
  if (/diverg|non-fast-forward|behind|merge/i.test(message))
    return {
      tab: "branches",
      detail:
        "Fetch current references, compare Branches and History, then merge the intended exact ref.",
    };
  if (/identity|user\.name|user\.email/i.test(message))
    return {
      tab: "connection",
      detail:
        "Configure the site user's Git name and email from Terminal, then retry.",
    };
  if (/upstream|tracking/i.test(message))
    return {
      tab: "branches",
      detail: "Choose an exact remote branch as the tracking upstream.",
    };
  return {
    tab: "connection",
    detail: "Refresh the repository state and review Connection & Recovery.",
  };
}

function graphLayout(commits: GitGraphCommit[]) {
  const laneByHash = new Map<string, number>();
  let nextLane = 0;
  const resolveHash = (value: string) =>
    commits.find(
      (commit) => commit.hash === value || commit.hash.startsWith(value),
    )?.hash;
  const nodes = commits.map((commit, index) => {
    let lane = laneByHash.get(commit.hash);
    if (lane === undefined) {
      lane = nextLane++;
      laneByHash.set(commit.hash, lane);
    }
    commit.parents.forEach((parent, parentIndex) => {
      const resolved = resolveHash(parent);
      if (!resolved || laneByHash.has(resolved)) return;
      laneByHash.set(resolved, parentIndex === 0 ? lane : nextLane++);
    });
    return { commit, index, lane };
  });
  const nodeByHash = new Map(nodes.map((node) => [node.commit.hash, node]));
  const edges = nodes.flatMap((node) =>
    node.commit.parents.flatMap((parent) => {
      const resolved = resolveHash(parent);
      const target = resolved ? nodeByHash.get(resolved) : undefined;
      return target ? [{ from: node, to: target }] : [];
    }),
  );
  return { nodes, edges, lanes: Math.max(1, nextLane) };
}

function CommitGraph({ commits }: { commits: GitGraphCommit[] }) {
  const bounded = useMemo(() => commits.slice(0, 50), [commits]);
  const layout = useMemo(() => graphLayout(bounded), [bounded]);
  const rowHeight = 72;
  const graphWidth = Math.max(64, layout.lanes * 28 + 28);
  const height = Math.max(rowHeight, bounded.length * rowHeight);
  if (!bounded.length)
    return (
      <p className="p-10 text-center text-sm text-slate-400">
        No structured history is available yet.
      </p>
    );
  return (
    <div className="relative overflow-x-auto" style={{ minHeight: height }}>
      <svg
        role="img"
        aria-label="Commit graph showing parent connections"
        width={graphWidth}
        height={height}
        className="absolute left-0 top-0"
      >
        {layout.edges.map(({ from, to }) => {
          const x1 = 22 + from.lane * 28;
          const y1 = from.index * rowHeight + 36;
          const x2 = 22 + to.lane * 28;
          const y2 = to.index * rowHeight + 36;
          const middle = y1 + (y2 - y1) / 2;
          return (
            <path
              key={`${from.commit.hash}:${to.commit.hash}`}
              d={`M ${x1} ${y1} C ${x1} ${middle}, ${x2} ${middle}, ${x2} ${y2}`}
              fill="none"
              stroke="#94a3b8"
              strokeWidth="2"
            />
          );
        })}
        {layout.nodes.map((node) => (
          <circle
            key={node.commit.hash}
            cx={22 + node.lane * 28}
            cy={node.index * rowHeight + 36}
            r="6"
            fill={node.index === 0 ? "#7c3aed" : "#ffffff"}
            stroke="#7c3aed"
            strokeWidth="3"
          />
        ))}
      </svg>
      <ol className="relative" style={{ marginLeft: graphWidth }}>
        {bounded.map((commit) => (
          <li
            key={commit.hash}
            className="flex h-[72px] min-w-[520px] items-center border-b px-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-xs font-semibold text-panel-700">
                  {commit.shortHash}
                </code>
                {commit.refs.map((ref) => (
                  <span
                    key={ref}
                    className="rounded-full bg-panel-50 px-2 py-0.5 text-[11px] font-semibold text-panel-700"
                  >
                    {ref}
                  </span>
                ))}
              </div>
              <p className="truncate text-sm font-medium text-slate-800">
                {commit.subject}
              </p>
              <p className="truncate text-xs text-slate-400">
                {commit.author} · {commit.date}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <ol className="sr-only">
        {bounded.map((commit) => (
          <li key={commit.hash}>
            Commit {commit.shortHash}: {commit.subject}. References:{" "}
            {commit.refs.join(", ") || "none"}. Parents:{" "}
            {commit.parents.join(", ") || "none"}.
          </li>
        ))}
      </ol>
    </div>
  );
}

export function GitManager({
  domain,
  initialData,
  apiBase = "",
  canWrite = false,
}: {
  domain: string;
  initialData: GitData;
  apiBase?: string;
  canWrite?: boolean;
}) {
  const [data, setData] = useState(initialData);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<GitTab>("deployment");
  const [actionError, setActionError] = useState("");
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [createBranchOpen, setCreateBranchOpen] = useState(false);
  const [updateFiles, setUpdateFiles] = useState(false);
  const [preserveExisting, setPreserveExisting] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState>(null);

  const endpoint = `${apiBase}/api/sites/${encodeURIComponent(domain)}/sections/git`;
  const routePrefix = apiBase
    ? apiBase
        .replace(/^\/api\/fleet\/servers\//, "/servers/")
        .replace(/\/proxy$/, "")
    : "";
  const siteRoute = `${routePrefix}/sites/${encodeURIComponent(domain)}`;

  const activateTab = useCallback((next: GitTab, push = true) => {
    setTab(next);
    if (!push || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("gitTab", next);
    window.history.pushState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, []);

  useEffect(() => {
    const sync = () => activateTab(queryTab(), false);
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [activateTab]);

  const refreshGit = useCallback(async () => {
    try {
      const result = await fetch(endpoint, { cache: "no-store" }).then(
        (response) => response.json(),
      );
      if (result.success) setData(result.data);
    } catch {
      // Keep the mutation error visible if this best-effort refresh also fails.
    }
  }, [endpoint]);

  async function action(input: Record<string, unknown>, message?: string) {
    if (!canWrite) return false;
    setBusy(true);
    setActionError("");
    try {
      const result = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }).then((response) => response.json());
      if (!result.success)
        throw new Error(result.error?.message || "Git operation failed");
      setData(result.data);
      if (result.data.notice) toast.warning(result.data.notice);
      else if (message) toast.success(message);
      return true;
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Git operation failed",
      );
      await refreshGit();
      return false;
    } finally {
      setBusy(false);
    }
  }

  function tabKeyDown(event: React.KeyboardEvent, current: GitTab) {
    const index = tabs.findIndex((item) => item.id === current);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft")
      next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    activateTab(tabs[next].id);
    document.getElementById(`git-tab-${tabs[next].id}`)?.focus();
  }

  const origin = data.remotes?.find(
    (remote) => remote[0] === "origin" && remote[2] === "(fetch)",
  )?.[1];
  const changes = data.changes ?? [];
  const localBranches = data.branches ?? [];
  const remoteBranches = data.remoteBranches ?? [];
  const recovery = actionError ? recoveryFor(actionError) : null;

  return (
    <div className="space-y-5">
      <section className="space-y-2 rounded-2xl border bg-white p-5 shadow-card">
        <h3 className="flex items-center gap-2 font-bold">
          <GitBranch className="h-5 w-5 text-panel-600" />
          {data.isRepository
            ? data.branch || "Detached checkout"
            : "No Git repository connected"}
        </h3>
        <p className="break-all text-sm text-slate-600">
          {origin || data.path}
        </p>
        {data.isRepository && (
          <>
            <code className="block break-all text-xs text-slate-500">
              {data.head || "No commits"}
            </code>
            <p className="text-xs text-slate-500">
              {changes.length
                ? `${changes.length} local changes`
                : "Working tree is clean"}
              {data.upstream
                ? ` · ${data.ahead ?? 0} ahead, ${data.behind ?? 0} behind ${data.upstream} (last fetched state)`
                : " · No upstream tracking branch"}
            </p>
          </>
        )}
        {!canWrite && (
          <p className="text-xs font-medium text-slate-500">Read-only access</p>
        )}
      </section>

      {data.notice && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          {data.notice}
        </div>
      )}
      {data.backup && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          <p className="font-semibold">Existing files backup</p>
          <p>{data.backup.detail}</p>
          {data.backup.path && (
            <code className="mt-1 block break-all text-xs">
              {data.backup.path}
            </code>
          )}
        </div>
      )}
      {actionError && recovery && (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        >
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" /> Git action failed
          </div>
          <p className="mt-1">{actionError}</p>
          <p className="mt-2 text-red-700">{recovery.detail}</p>
          <button
            type="button"
            className="mt-2 font-semibold underline"
            onClick={() => activateTab(recovery.tab)}
          >
            Open {tabs.find((item) => item.id === recovery.tab)?.label}
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border bg-white p-1 shadow-sm">
        <div
          role="tablist"
          aria-label="Git tools"
          className="flex min-w-max gap-1"
        >
          {tabs.map((item) => (
            <button
              key={item.id}
              id={`git-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-controls={`git-panel-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              onKeyDown={(event) => tabKeyDown(event, item.id)}
              onClick={() => activateTab(item.id)}
              className={`rounded-lg px-3 py-2 text-sm font-semibold ${
                tab === item.id
                  ? "bg-panel-600 text-white"
                  : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "deployment" && (
        <div
          id="git-panel-deployment"
          role="tabpanel"
          aria-labelledby="git-tab-deployment"
          className="space-y-5"
        >
          <DeploymentManager
            domain={domain}
            apiBase={apiBase}
            canWrite={canWrite}
            source="current"
            branch={data.branch}
            onFinished={refreshGit}
            blockedReason={
              data.isRepository
                ? !origin
                  ? "Connect an origin remote in Connection & Recovery."
                  : !data.branch
                    ? "Check out a branch in Branches before deploying."
                    : changes.length
                      ? "Commit or explicitly discard local changes in Changes before deploying latest changes."
                      : data.ahead
                        ? "The local branch is ahead or diverged. Review Branches and History before deploying."
                        : undefined
                : undefined
            }
          />
          {data.deployment && <DeploymentOutput result={data} />}
          {data.isRepository && canWrite && (
            <section className="rounded-2xl border bg-white p-5 shadow-card">
              <h3 className="font-bold">Update source without deployment</h3>
              <p className="mt-1 text-sm text-slate-500">
                Pull the latest files without build, migration, or restart
                steps. PHP and static websites may change immediately.
              </p>
              <Button
                className="mt-3"
                variant="outline"
                disabled={busy || !origin || !data.branch || changes.length > 0}
                onClick={() => setUpdateFiles(true)}
              >
                <ArrowDownToLine className="h-4 w-4" /> Update files only
              </Button>
            </section>
          )}
        </div>
      )}

      {tab === "changes" && (
        <div
          id="git-panel-changes"
          role="tabpanel"
          aria-labelledby="git-tab-changes"
        >
          <section className="rounded-2xl border bg-white shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
              <div>
                <h3 className="font-bold">Working tree</h3>
                <p className="text-xs text-slate-500">
                  {data.isRepository
                    ? `${changes.length} changed files`
                    : "Connect or initialize a repository first"}
                </p>
              </div>
              {canWrite && data.isRepository && (
                <div className="flex gap-2">
                  {changes.length > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setConfirm({ kind: "all" })}
                    >
                      <Trash2 className="h-4 w-4" /> Discard all
                    </Button>
                  )}
                  <Button
                    size="sm"
                    disabled={!changes.length || busy}
                    onClick={() => setCommitOpen(true)}
                  >
                    <GitCommit className="h-4 w-4" /> Commit
                  </Button>
                </div>
              )}
            </div>
            {changes.length ? (
              <div className="divide-y">
                {changes.map((change) => (
                  <div
                    key={`${change.status}:${change.path}`}
                    className="group flex items-center gap-2 px-3 py-1.5"
                  >
                    <button
                      disabled={busy || !canWrite}
                      onClick={() =>
                        void action({ action: "diff", path: change.path })
                      }
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left text-sm hover:bg-slate-50 disabled:opacity-60"
                    >
                      <FileDiff className="h-4 w-4 shrink-0 text-slate-400" />
                      <code className="w-7 shrink-0 text-amber-600">
                        {change.status}
                      </code>
                      <span className="truncate">
                        {change.originalPath
                          ? `${change.originalPath} → ${change.path}`
                          : change.path}
                      </span>
                    </button>
                    {canWrite && (
                      <Button
                        title={`Discard changes in ${change.path}`}
                        aria-label={`Discard changes in ${change.path}`}
                        variant="ghost"
                        size="icon"
                        disabled={busy}
                        onClick={() => setConfirm({ kind: "file", change })}
                      >
                        <RotateCcw className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-10 text-center text-sm text-slate-400">
                <Check className="mx-auto mb-2 h-6 w-6 text-emerald-500" />
                {data.isRepository
                  ? "Working tree is clean"
                  : "No repository connected"}
              </div>
            )}
          </section>
        </div>
      )}

      {tab === "branches" && (
        <div
          id="git-panel-branches"
          role="tabpanel"
          aria-labelledby="git-tab-branches"
          className="space-y-5"
        >
          <section className="rounded-2xl border bg-white p-5 shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-bold">Branch controls</h3>
                <p className="mt-1 text-sm text-slate-500">
                  Switch exact refs, set tracking, or merge into{" "}
                  {data.branch || "the current checkout"}.
                </p>
              </div>
              {canWrite && data.isRepository && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !origin}
                    onClick={() =>
                      void action({ action: "fetch" }, "Remote status updated")
                    }
                  >
                    <RefreshCw className="h-4 w-4" /> Fetch
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy || !origin || !data.branch}
                    onClick={() =>
                      void action(
                        { action: "push", branch: data.branch },
                        "Changes pushed",
                      )
                    }
                  >
                    <ArrowUpFromLine className="h-4 w-4" /> Push
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setCreateBranchOpen(true)}
                  >
                    <Plus className="h-4 w-4" /> Create branch
                  </Button>
                </div>
              )}
            </div>
          </section>
          <div className="grid gap-5 lg:grid-cols-2">
            <BranchList
              title="Local branches"
              branches={localBranches}
              current={data.branch}
              busy={busy}
              canWrite={canWrite}
              checkout={(branch) => setConfirm({ kind: "checkout", branch })}
              merge={(branch) => setConfirm({ kind: "merge", branch })}
              clean={!changes.length}
            />
            <BranchList
              title="Remote branches"
              branches={remoteBranches}
              current={data.upstream}
              busy={busy}
              canWrite={canWrite}
              checkout={(branch) => setConfirm({ kind: "checkout", branch })}
              merge={(branch) => setConfirm({ kind: "merge", branch })}
              clean={!changes.length}
            />
          </div>
          <section className="rounded-2xl border bg-white p-5 shadow-card">
            <h3 className="font-bold">Tracking upstream</h3>
            <p className="mt-1 text-sm text-slate-500">
              Current: {data.upstream || "none"}
            </p>
            {canWrite && remoteBranches.length > 0 && (
              <form
                className="mt-4 flex max-w-xl flex-col gap-3 sm:flex-row"
                onSubmit={(event) => {
                  event.preventDefault();
                  const branch = String(
                    new FormData(event.currentTarget).get("branch"),
                  );
                  void action(
                    { action: "set-upstream", branch },
                    "Tracking upstream updated",
                  );
                }}
              >
                <Label htmlFor="git-upstream" className="sr-only">
                  Remote branch
                </Label>
                <select
                  id="git-upstream"
                  name="branch"
                  defaultValue={data.upstream}
                  className="h-10 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-sm"
                >
                  {remoteBranches.map((branch) => (
                    <option key={branch}>{branch}</option>
                  ))}
                </select>
                <Button disabled={busy}>Set upstream</Button>
              </form>
            )}
          </section>
        </div>
      )}

      {tab === "history" && (
        <div
          id="git-panel-history"
          role="tabpanel"
          aria-labelledby="git-tab-history"
        >
          <section className="overflow-hidden rounded-2xl border bg-white shadow-card">
            <div className="flex items-center gap-2 border-b px-5 py-4">
              <History className="h-5 w-5 text-panel-600" />
              <div>
                <h3 className="font-bold">Repository history</h3>
                <p className="text-xs text-slate-500">
                  Real parent links and references from the latest bounded
                  history.
                </p>
              </div>
            </div>
            {data.graph?.length ? (
              <CommitGraph commits={data.graph} />
            ) : (
              <div className="divide-y">
                {data.commits?.length ? (
                  data.commits.map((commit) => (
                    <div
                      key={commit.hash}
                      className="grid gap-1 px-5 py-3 sm:grid-cols-[90px_1fr_220px]"
                    >
                      <code className="text-panel-600">{commit.hash}</code>
                      <span className="text-sm font-medium">
                        {commit.subject}
                      </span>
                      <span className="text-xs text-slate-400">
                        {commit.author} · {commit.date}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="p-10 text-center text-sm text-slate-400">
                    No commits yet.
                  </p>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      {tab === "connection" && (
        <div
          id="git-panel-connection"
          role="tabpanel"
          aria-labelledby="git-tab-connection"
          className="space-y-5"
        >
          {!data.isRepository ? (
            <ConnectRepository
              data={data}
              busy={busy}
              canWrite={canWrite}
              preserveExisting={preserveExisting}
              setPreserveExisting={setPreserveExisting}
              clone={(url, branch) =>
                void action(
                  {
                    action: "clone",
                    url,
                    branch,
                    ...(preserveExisting ? { preserveExisting: true } : {}),
                  },
                  "Repository cloned",
                )
              }
              initialize={() =>
                void action({ action: "init" }, "Repository initialized")
              }
            />
          ) : (
            <section className="rounded-2xl border bg-white p-5 shadow-card">
              <div className="flex items-start gap-3">
                <Link2 className="mt-0.5 h-5 w-5 text-panel-600" />
                <div className="min-w-0 flex-1">
                  <h3 className="font-bold">Origin connection</h3>
                  <p className="mt-1 break-all text-sm text-slate-600">
                    {origin || "No origin remote configured"}
                  </p>
                </div>
                {canWrite && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRemoteOpen(true)}
                  >
                    Edit remote
                  </Button>
                )}
              </div>
            </section>
          )}
          {canWrite && (
            <section className="rounded-2xl border bg-white p-5 shadow-card">
              <h3 className="font-bold">Private repository access</h3>
              <p className="mt-1 text-sm text-slate-500">
                Add this website&apos;s public key to a private repository
                before cloning with its SSH URL.
              </p>
              <DeploymentKey domain={domain} apiBase={apiBase} />
            </section>
          )}
          {data.isRepository && (
            <RecoveryPanel
              data={data}
              busy={busy}
              canWrite={canWrite}
              filesUrl={`${siteRoute}/file-manager`}
              terminalUrl={`${siteRoute}/terminal`}
              resolveWorking={(path) =>
                void action(
                  {
                    action: "resolve-conflict",
                    path,
                    choice: "working",
                  },
                  `${path} marked resolved`,
                )
              }
              resolveVersion={(path, choice) =>
                setConfirm({ kind: "resolve", path, choice })
              }
              continueOperation={() =>
                void action({ action: "continue" }, "Git operation continued")
              }
              abortOperation={(operation) =>
                setConfirm({ kind: "abort", operation })
              }
            />
          )}
        </div>
      )}

      {updateFiles && (
        <ConfirmDialog
          title="Update files only?"
          message="This updates source files without building or restarting the application. PHP and static websites may change immediately."
          confirmText="Update files"
          variant="default"
          onCancel={() => setUpdateFiles(false)}
          onConfirm={() => {
            setUpdateFiles(false);
            void action(
              { action: "pull", branch: data.branch, filesOnly: true },
              "Source files updated; deployment steps were skipped",
            );
          }}
        />
      )}
      {data.selectedDiff && (
        <DiffModal
          value={data.selectedDiff}
          close={() =>
            setData((current) => ({
              ...current,
              selectedDiff: undefined,
            }))
          }
        />
      )}
      {remoteOpen && (
        <Modal title="Origin remote" close={() => setRemoteOpen(false)}>
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              const url = String(new FormData(event.currentTarget).get("url"));
              if (await action({ action: "set-remote", url }, "Remote updated"))
                setRemoteOpen(false);
            }}
          >
            <div>
              <Label htmlFor="git-remote-url">Git URL</Label>
              <Input
                id="git-remote-url"
                name="url"
                defaultValue={origin}
                placeholder="git@github.com:owner/repository.git"
                required
              />
            </div>
            <p className="text-xs text-slate-500">
              SSH remotes use the deployment public key shown in this tab.
            </p>
            <Button disabled={busy}>Save remote</Button>
          </form>
        </Modal>
      )}
      {commitOpen && (
        <Modal title="Commit changes" close={() => setCommitOpen(false)}>
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              const message = String(
                new FormData(event.currentTarget).get("message"),
              );
              if (
                await action({ action: "commit", message }, "Changes committed")
              )
                setCommitOpen(false);
            }}
          >
            <div>
              <Label htmlFor="git-commit-message">Commit message</Label>
              <Input
                id="git-commit-message"
                name="message"
                autoFocus
                required
              />
            </div>
            <Button disabled={busy}>Commit all changes</Button>
          </form>
        </Modal>
      )}
      {createBranchOpen && (
        <Modal title="Create branch" close={() => setCreateBranchOpen(false)}>
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              const branch = String(
                new FormData(event.currentTarget).get("branch"),
              );
              if (
                await action(
                  { action: "create-branch", branch },
                  `Created ${branch}`,
                )
              )
                setCreateBranchOpen(false);
            }}
          >
            <div>
              <Label htmlFor="git-new-branch">Branch name</Label>
              <Input id="git-new-branch" name="branch" autoFocus required />
            </div>
            <p className="text-xs text-slate-500">
              Creates a local branch from the current commit without publishing
              it.
            </p>
            <Button disabled={busy}>Create branch</Button>
          </form>
        </Modal>
      )}
      {confirm && (
        <GitConfirmation
          value={confirm}
          close={() => setConfirm(null)}
          run={(input, message) => void action(input, message)}
          currentBranch={data.branch}
        />
      )}
    </div>
  );
}

function BranchList({
  title,
  branches,
  current,
  busy,
  canWrite,
  checkout,
  merge,
  clean,
}: {
  title: string;
  branches: string[];
  current?: string;
  busy: boolean;
  canWrite: boolean;
  checkout: (branch: string) => void;
  merge: (branch: string) => void;
  clean: boolean;
}) {
  return (
    <section className="rounded-2xl border bg-white shadow-card">
      <div className="border-b px-5 py-4">
        <h3 className="font-bold">{title}</h3>
      </div>
      {branches.length ? (
        <div className="divide-y">
          {branches.map((branch) => {
            const selected = branch === current;
            return (
              <div
                key={branch}
                className={`flex items-center gap-2 px-4 py-3 ${selected ? "bg-panel-50" : ""}`}
              >
                <GitBranch className="h-4 w-4 text-slate-400" />
                <code className="min-w-0 flex-1 truncate text-sm">
                  {branch}
                </code>
                {selected && (
                  <span className="text-xs font-semibold text-panel-700">
                    current
                  </span>
                )}
                {canWrite && !selected && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => checkout(branch)}
                    >
                      Switch
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || !clean}
                      onClick={() => merge(branch)}
                    >
                      <GitMerge className="h-4 w-4" /> Merge
                    </Button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="p-6 text-sm text-slate-400">No branches reported.</p>
      )}
    </section>
  );
}

function ConnectRepository({
  data,
  busy,
  canWrite,
  preserveExisting,
  setPreserveExisting,
  clone,
  initialize,
}: {
  data: GitData;
  busy: boolean;
  canWrite: boolean;
  preserveExisting: boolean;
  setPreserveExisting: (value: boolean) => void;
  clone: (url: string, branch: string) => void;
  initialize: () => void;
}) {
  const readiness = data.cloneReadiness;
  const needsPreserve = readiness?.status === "files";
  const blocked = readiness?.status === "blocked";
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card">
      <div className="text-center">
        <GitFork className="mx-auto h-10 w-10 text-panel-500" />
        <h3 className="mt-3 text-xl font-bold">Connect a Git repository</h3>
        <p className="mt-2 text-sm text-slate-500">
          Clone a repository or initialize Git around the current files.
        </p>
      </div>
      {readiness && (
        <div
          className={`mx-auto mt-5 max-w-2xl rounded-xl border p-4 text-sm ${
            blocked
              ? "border-red-200 bg-red-50 text-red-800"
              : "border-slate-200 bg-slate-50 text-slate-700"
          }`}
        >
          <p className="font-semibold">{readiness.detail}</p>
          {readiness.files.length > 0 && (
            <>
              <p className="mt-3 text-xs font-semibold uppercase tracking-wide">
                Files currently present
              </p>
              <ul className="mt-1 max-h-40 overflow-auto rounded bg-white p-3 font-mono text-xs">
                {readiness.files.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            </>
          )}
          {readiness.status === "scaffold" && (
            <p className="mt-2 text-xs">
              The recognized scaffold is fingerprinted automatically. The
              .well-known directory is preserved.
            </p>
          )}
        </div>
      )}
      {canWrite ? (
        <>
          <form
            className="mx-auto mt-5 max-w-2xl space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              clone(String(form.get("url")), String(form.get("branch")));
            }}
          >
            <div>
              <Label htmlFor="git-clone-url">Repository URL</Label>
              <Input
                id="git-clone-url"
                name="url"
                placeholder="git@github.com:owner/repository.git"
                required
              />
            </div>
            <div>
              <Label htmlFor="git-clone-branch">Branch (optional)</Label>
              <Input id="git-clone-branch" name="branch" placeholder="main" />
            </div>
            {needsPreserve && (
              <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <input
                  type="checkbox"
                  checked={preserveExisting}
                  onChange={(event) =>
                    setPreserveExisting(event.target.checked)
                  }
                  className="mt-0.5"
                />
                <span>
                  <b>Back up and preserve the listed files before cloning.</b>{" "}
                  Panelavo will report the backup result. Nothing is removed
                  without this explicit choice.
                </span>
              </label>
            )}
            <Button
              disabled={busy || blocked || (needsPreserve && !preserveExisting)}
            >
              {busy && <LoaderCircle className="h-4 w-4 animate-spin" />} Clone
              repository
            </Button>
          </form>
          <div className="mx-auto mt-5 flex max-w-2xl items-center gap-3">
            <span className="h-px flex-1 bg-slate-200" />
            <span className="text-xs text-slate-400">
              or keep the current files
            </span>
            <span className="h-px flex-1 bg-slate-200" />
          </div>
          <div className="mt-4 text-center">
            <Button variant="outline" disabled={busy} onClick={initialize}>
              Initialize existing directory
            </Button>
          </div>
        </>
      ) : (
        <p className="mt-5 text-center text-sm text-slate-500">
          Read-only access. A website manager can connect or initialize this
          directory.
        </p>
      )}
    </section>
  );
}

function RecoveryPanel({
  data,
  busy,
  canWrite,
  filesUrl,
  terminalUrl,
  resolveWorking,
  resolveVersion,
  continueOperation,
  abortOperation,
}: {
  data: GitData;
  busy: boolean;
  canWrite: boolean;
  filesUrl: string;
  terminalUrl: string;
  resolveWorking: (path: string) => void;
  resolveVersion: (path: string, choice: "ours" | "theirs") => void;
  continueOperation: () => void;
  abortOperation: (
    operation: Exclude<GitData["state"], undefined>["operation"],
  ) => void;
}) {
  const state = data.state ?? { operation: null, conflictedFiles: [] };
  return (
    <section className="rounded-2xl border bg-white p-5 shadow-card">
      <h3 className="font-bold">Recovery</h3>
      {state.operation ? (
        <>
          <p className="mt-1 text-sm text-slate-600">
            A <b>{state.operation}</b> is in progress. Resolve every file before
            continuing, or abort to return to the pre-operation state.
          </p>
          <div className="mt-4 divide-y rounded-xl border">
            {state.conflictedFiles.map((path) => (
              <div key={path} className="p-3">
                <code className="break-all text-sm font-semibold">{path}</code>
                <div className="mt-2 flex flex-wrap gap-2">
                  <a
                    href={`${filesUrl}?path=${encodeURIComponent(path)}`}
                    className="rounded-lg border px-3 py-1.5 text-xs font-semibold text-slate-700"
                  >
                    Open Files
                  </a>
                  <a
                    href={terminalUrl}
                    className="rounded-lg border px-3 py-1.5 text-xs font-semibold text-slate-700"
                  >
                    Open Terminal
                  </a>
                  {canWrite && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => resolveWorking(path)}
                    >
                      Mark edited file resolved
                    </Button>
                  )}
                  {canWrite && state.operation === "merge" && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => resolveVersion(path, "ours")}
                      >
                        Use ours
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => resolveVersion(path, "theirs")}
                      >
                        Use theirs
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          {canWrite && (
            <div className="mt-4 flex gap-2">
              <Button
                disabled={busy || state.conflictedFiles.length > 0}
                onClick={continueOperation}
              >
                Continue {state.operation}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => abortOperation(state.operation)}
              >
                Abort {state.operation}
              </Button>
            </div>
          )}
        </>
      ) : (
        <p className="mt-2 text-sm text-slate-500">
          No merge, rebase, cherry-pick, or revert is in progress.
        </p>
      )}
      {!data.upstream && data.isRepository && (
        <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          No upstream is configured. Choose an exact remote branch in Branches.
        </p>
      )}
    </section>
  );
}

function GitConfirmation({
  value,
  close,
  run,
  currentBranch,
}: {
  value: Exclude<ConfirmState, null>;
  close: () => void;
  run: (input: Record<string, unknown>, message: string) => void;
  currentBranch?: string;
}) {
  let title = "Confirm Git action";
  let message = "Review this action before continuing.";
  let confirmText = "Continue";
  let input: Record<string, unknown> = {};
  let success = "Git action completed";
  if (value.kind === "all") {
    title = "Discard all changes?";
    message =
      "This permanently removes all uncommitted work, including untracked files. This cannot be undone.";
    confirmText = "Discard all";
    input = { action: "discard-all" };
    success = "All changes discarded";
  } else if (value.kind === "file") {
    title = `Discard changes in ${value.change.path}?`;
    message =
      "This permanently removes the selected uncommitted work, including an untracked file. This cannot be undone.";
    confirmText = "Discard file";
    input = { action: "discard", path: value.change.path };
    success = "File changes discarded";
  } else if (value.kind === "checkout") {
    title = `Switch to ${value.branch}?`;
    message = `Check out the exact ref ${value.branch}. Website files may change immediately, especially for PHP or static sites. The working tree must be clean.`;
    confirmText = "Switch branch";
    input = { action: "checkout", branch: value.branch };
    success = `Switched to ${value.branch}`;
  } else if (value.kind === "merge") {
    title = `Merge ${value.branch} into ${currentBranch || "the current checkout"}?`;
    message = `Preview: merge the exact ref ${value.branch} into ${currentBranch || "the current checkout"}. This may change website files and can create conflicts. The working tree must be clean.`;
    confirmText = "Merge branch";
    input = { action: "merge", branch: value.branch };
    success = `Merged ${value.branch}`;
  } else if (value.kind === "resolve") {
    title = `Replace ${value.path} with ${value.choice}?`;
    message = `This replaces the selected file with the ${value.choice} merge version and marks it resolved. Any manual edits in that file will be lost.`;
    confirmText = `Use ${value.choice}`;
    input = {
      action: "resolve-conflict",
      path: value.path,
      choice: value.choice,
    };
    success = `${value.path} resolved`;
  } else if (value.kind === "abort") {
    title = `Abort ${value.operation}?`;
    message = `Stop the active ${value.operation} and restore its pre-operation state. Review unrelated working-tree changes afterward.`;
    confirmText = `Abort ${value.operation}`;
    input = { action: "abort" };
    success = `${value.operation} aborted`;
  }
  return (
    <ConfirmDialog
      title={title}
      message={message}
      confirmText={confirmText}
      onCancel={close}
      onConfirm={() => {
        close();
        run(input, success);
      }}
    />
  );
}

type DiffRow = {
  oldNumber?: number;
  newNumber?: number;
  oldText?: string;
  newText?: string;
  oldKind?: "delete";
  newKind?: "add";
};

function parseDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  const lines = diff.split("\n");
  let oldNumber = 0;
  let newNumber = 0;
  let index = 0;
  while (index < lines.length) {
    const header = lines[index].match(
      /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/,
    );
    if (!header) {
      index++;
      continue;
    }
    oldNumber = Number(header[1]);
    newNumber = Number(header[2]);
    index++;
    while (index < lines.length && !lines[index].startsWith("@@ ")) {
      if (lines[index].startsWith("-")) {
        const deleted: { number: number; text: string }[] = [];
        const added: { number: number; text: string }[] = [];
        while (index < lines.length && lines[index].startsWith("-"))
          deleted.push({ number: oldNumber++, text: lines[index++].slice(1) });
        while (index < lines.length && lines[index].startsWith("+"))
          added.push({ number: newNumber++, text: lines[index++].slice(1) });
        for (
          let pair = 0;
          pair < Math.max(deleted.length, added.length);
          pair++
        )
          rows.push({
            oldNumber: deleted[pair]?.number,
            oldText: deleted[pair]?.text,
            oldKind: deleted[pair] ? "delete" : undefined,
            newNumber: added[pair]?.number,
            newText: added[pair]?.text,
            newKind: added[pair] ? "add" : undefined,
          });
      } else if (lines[index].startsWith("+")) {
        rows.push({
          newNumber: newNumber++,
          newText: lines[index].slice(1),
          newKind: "add",
        });
        index++;
      } else if (lines[index].startsWith(" ")) {
        const text = lines[index].slice(1);
        rows.push({
          oldNumber: oldNumber++,
          newNumber: newNumber++,
          oldText: text,
          newText: text,
        });
        index++;
      } else index++;
    }
  }
  return rows;
}

function DiffModal({
  value,
  close,
}: {
  value: { path: string; diff: string };
  close: () => void;
}) {
  const rows = parseDiff(value.diff);
  const dialogRef = useDialogFocus(close);
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/50 p-3">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Changes in ${value.path}`}
        className="flex h-[90vh] w-full max-w-[96rem] flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
      >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="min-w-0">
            <h3 className="truncate font-semibold">{value.path}</h3>
            <p className="text-xs text-slate-500">
              Side-by-side uncommitted changes
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={close}
            aria-label="Close diff"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
        <div className="grid grid-cols-2 border-b bg-slate-50 text-xs font-medium text-slate-500">
          <div className="border-r px-4 py-2">Original</div>
          <div className="px-4 py-2">Working tree</div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-white font-mono text-xs">
          {rows.length ? (
            rows.map((row, index) => (
              <div key={index} className="grid min-w-[900px] grid-cols-2">
                <DiffCell
                  number={row.oldNumber}
                  text={row.oldText}
                  kind={row.oldKind}
                />
                <DiffCell
                  number={row.newNumber}
                  text={row.newText}
                  kind={row.newKind}
                />
              </div>
            ))
          ) : (
            <div className="grid h-full place-items-center p-8 text-sm text-slate-500">
              No text diff is available for this file. It may be binary or
              unchanged.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DiffCell({
  number,
  text,
  kind,
}: {
  number?: number;
  text?: string;
  kind?: "add" | "delete";
}) {
  return (
    <div
      className={`grid min-h-5 grid-cols-[3.5rem_1fr] border-r ${
        kind === "add" ? "bg-emerald-50" : kind === "delete" ? "bg-red-50" : ""
      }`}
    >
      <span className="select-none border-r px-2 text-right text-slate-400">
        {number}
      </span>
      <pre className="whitespace-pre px-2">{text ?? ""}</pre>
    </div>
  );
}

function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const dialogRef = useDialogFocus(close);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-2xl bg-white p-6 shadow-2xl"
      >
        <div className="mb-5 flex justify-between">
          <h3 className="text-lg font-bold">{title}</h3>
          <button aria-label="Close dialog" onClick={close}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
