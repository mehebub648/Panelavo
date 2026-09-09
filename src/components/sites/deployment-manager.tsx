"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DeployHookManager } from "@/components/sites/deploy-hook-manager";
import type { McpJob } from "@/server/jobs/background-jobs";
import type { DeploymentResult } from "@/lib/deployment";

export function DeploymentOutput({ result }: { result: DeploymentResult }) {
  return (
    <div className="space-y-2">
      {result.source && (
        <p className="break-all text-xs text-slate-500">
          {result.source.status === "updated"
            ? "Source updated"
            : "Current files"}
          {result.source.commit ? ` · ${result.source.commit}` : ""}
          {result.source.localChanges ? " · includes local changes" : ""}
        </p>
      )}
      {result.deployment?.steps.map((step, index) => (
        <details
          key={`${index}:${step.command}`}
          open={step.exitCode !== 0}
          className="rounded-lg border p-3"
        >
          <summary className="cursor-pointer text-sm font-medium">
            {step.exitCode === 0 ? "Completed" : "Failed"}: {step.label}
          </summary>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-3 text-xs text-slate-100">
            {step.output || "No output."}
          </pre>
        </details>
      ))}
    </div>
  );
}

export function DeploymentManager({
  domain,
  apiBase = "",
  canWrite,
  branch,
  source = "latest",
  blockedReason,
  onFinished,
  compact = false,
}: {
  domain: string;
  apiBase?: string;
  canWrite: boolean;
  branch?: string;
  source?: "latest" | "current";
  blockedReason?: string;
  onFinished?: () => void;
  compact?: boolean;
}) {
  const base = `${apiBase}/api/sites/${encodeURIComponent(domain)}`;
  const pendingKey = useRef<string | undefined>(undefined);
  const [jobs, setJobs] = useState<McpJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [historyUnavailable, setHistoryUnavailable] = useState(true);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selected, setSelected] = useState<string>();
  const active = jobs.find((job) => ["queued", "running"].includes(job.status));
  const latest = jobs.find((job) => job.id === selected) ?? jobs[0];
  const lastSuccess = jobs.find((job) => job.status === "succeeded");
  const successfulCommit = (lastSuccess?.result as DeploymentResult | undefined)
    ?.source?.commit;
  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${base}/deployments`, {
        cache: "no-store",
      });
      const result = await response.json();
      if (!result.success)
        throw new Error(
          result.error?.message || "Deployment history could not be loaded.",
        );
      setHistoryUnavailable(false);
      setJobs(result.data.jobs ?? []);
      setError("");
    } catch (reason) {
      setHistoryUnavailable(true);
      setError(
        reason instanceof Error
          ? reason.message
          : "Deployment history could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, [base]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [active, refresh]);
  useEffect(() => {
    if (latest?.finishedAt) onFinished?.();
  }, [latest?.finishedAt, onFinished]);
  async function deploy() {
    setConfirm(false);
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(`${base}/deployments`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": (pendingKey.current ??= crypto.randomUUID()),
        },
        body: JSON.stringify({
          source,
          ...(source === "latest" && branch ? { branch } : {}),
        }),
      });
      const result = await response.json();
      if (!result.success) {
        if (response.status >= 400 && response.status < 500)
          pendingKey.current = undefined;
        throw new Error(result.error?.message || "Deployment could not start.");
      }
      pendingKey.current = undefined;
      setSelected(result.data.id);
      setJobs((items) => [
        result.data,
        ...items.filter((item) => item.id !== result.data.id),
      ]);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Deployment could not start.",
      );
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <section
      className="min-w-0 space-y-4 rounded-2xl border bg-white p-5 shadow-card"
      aria-label="Deployment"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-bold">Deployment</h3>
          <p className="mt-1 text-xs text-slate-500">
            {lastSuccess?.finishedAt
              ? `Last successful deployment: ${new Date(lastSuccess.finishedAt).toLocaleString()}${successfulCommit ? ` · ${successfulCommit.slice(0, 12)}` : ""}`
              : loading
                ? "Loading deployment history…"
                : "No successful deployment in recent history."}
          </p>
        </div>
        {canWrite && (
          <Button
            onClick={() => setConfirm(true)}
            disabled={
              loading ||
              historyUnavailable ||
              submitting ||
              Boolean(active) ||
              Boolean(blockedReason)
            }
          >
            {active || submitting ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Rocket className="h-4 w-4" />
            )}
            {active
              ? "Deployment running"
              : source === "latest"
                ? "Deploy latest changes"
                : "Deploy current files"}
          </Button>
        )}
      </div>
      {blockedReason && canWrite && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          {blockedReason}
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-lg bg-red-50 p-3 text-sm text-red-800"
        >
          {error}{" "}
          <Button variant="ghost" size="sm" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      )}
      {latest && (
        <div className="space-y-3" aria-live="polite">
          <p className="text-sm font-semibold">
            {latest.kind}: {latest.status.replaceAll("-", " ")}
          </p>
          {latest.error && (
            <p className="text-sm text-red-700">{latest.error}</p>
          )}
          {canWrite && (
            <>
              {latest.result == null &&
                latest.progress?.map((event, index) => (
                  <div key={index} className="text-sm">
                    <span>
                      {event.label}: {event.status}
                    </span>
                    {event.commit && (
                      <code className="ml-2 break-all text-xs">
                        {event.commit}
                      </code>
                    )}
                    {event.status === "failed" && event.output && (
                      <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-3 text-xs text-slate-100">
                        {event.output}
                      </pre>
                    )}
                  </div>
                ))}
              {latest.result != null && (
                <DeploymentOutput result={latest.result as DeploymentResult} />
              )}
            </>
          )}
        </div>
      )}
      {jobs.length > 1 && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            Deployment history
          </summary>
          <div className="mt-2 space-y-1">
            {jobs.map((job) => (
              <button
                key={job.id}
                onClick={() => setSelected(job.id)}
                className="block w-full rounded p-2 text-left text-xs hover:bg-slate-50"
              >
                {new Date(job.createdAt).toLocaleString()} · {job.kind} ·{" "}
                {job.status}
              </button>
            ))}
          </div>
        </details>
      )}
      {canWrite && !compact && (
        <details
          onToggle={(event) => setSettingsOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer text-sm font-medium">
            Deployment settings & automatic deployment
          </summary>
          {settingsOpen && (
            <div className="mt-4">
              <DeployHookManager domain={domain} apiBase={apiBase} />
            </div>
          )}
        </details>
      )}
      {confirm && (
        <ConfirmDialog
          title={
            source === "latest"
              ? "Deploy latest changes?"
              : "Deploy current files?"
          }
          message={
            source === "latest"
              ? "Update to the configured branch, run the deployment steps, and check the application. This updates the current application directory and may briefly interrupt traffic."
              : "Run deployment steps on the files currently in the application directory, including local changes. This may briefly interrupt traffic."
          }
          confirmText="Deploy"
          variant="default"
          onCancel={() => setConfirm(false)}
          onConfirm={() => void deploy()}
        />
      )}
    </section>
  );
}
