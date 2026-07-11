"use client";

import React, {
  useEffect,
  useRef,
  useState,
  useTransition,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useRouter } from "next/navigation";
import {
  Boxes,
  CircleCheck,
  CircleHelp,
  CircleX,
  Database,
  Hammer,
  Layers3,
  LoaderCircle,
  Package,
  Play,
  RefreshCw,
  RotateCcw,
  ScrollText,
  ShieldAlert,
  Square,
  Terminal,
  Trash2,
  TriangleAlert,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import type {
  DeploymentPlan,
  OperationAction,
  OperationRun,
  OperationStatus,
  OperationsData,
} from "@/types/operations";

const ICONS: Record<OperationAction["iconKey"], LucideIcon> = {
  box: Boxes,
  build: Hammer,
  cache: Layers3,
  check: CircleCheck,
  database: Database,
  logs: ScrollText,
  package: Package,
  play: Play,
  refresh: RefreshCw,
  stop: Square,
  terminal: Terminal,
  trash: Trash2,
};

const STATUS: Record<
  OperationStatus,
  { label: string; icon: LucideIcon; badge: string; panel: string }
> = {
  ready: {
    label: "Ready",
    icon: CircleCheck,
    badge: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
    panel: "border-emerald-200/70 bg-emerald-50/45",
  },
  warning: {
    label: "Warning",
    icon: TriangleAlert,
    badge: "bg-amber-50 text-amber-700 ring-amber-600/20",
    panel: "border-amber-200/70 bg-amber-50/45",
  },
  blocked: {
    label: "Blocked",
    icon: CircleX,
    badge: "bg-red-50 text-red-700 ring-red-600/20",
    panel: "border-red-200/70 bg-red-50/45",
  },
  unauthorized: {
    label: "Read only",
    icon: ShieldAlert,
    badge: "bg-red-50 text-red-700 ring-red-600/20",
    panel: "border-red-200/70 bg-red-50/45",
  },
  unsupported: {
    label: "Unsupported",
    icon: CircleHelp,
    badge: "bg-slate-100 text-slate-600 ring-slate-500/20",
    panel: "border-slate-200 bg-slate-50/70",
  },
};

type ConfirmationRequest = {
  title: string;
  message: string;
  confirmText?: string;
  variant: "danger" | "default";
  run: () => void;
};

type ApiResponse = {
  success?: boolean;
  data?: OperationsData;
  error?: { message?: string };
};

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatCheckedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

function humanize(value: string) {
  return value.replaceAll("-", " ");
}

function actionKey(action: OperationAction) {
  const input = action.input?.script ?? action.input?.name;
  return input ? `${action.id}:${input}` : action.id;
}

function htmlId(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/g, "-");
}

function isActionReady(status: OperationStatus) {
  return status === "ready" || status === "warning";
}

function StatusBadge({ status }: { status: OperationStatus }) {
  const metadata = STATUS[status];
  const Icon = metadata.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset",
        metadata.badge,
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {metadata.label}
    </span>
  );
}

function runStatus(run: OperationRun) {
  if (run.timedOut)
    return { label: "Timed out", className: STATUS.warning.badge };
  if (run.exitCode === 0)
    return { label: "Success", className: STATUS.ready.badge };
  return {
    label: `Exit code ${run.exitCode}`,
    className: STATUS.blocked.badge,
  };
}

export function ActionsManager({
  domain,
  initialData,
}: {
  domain: string;
  initialData: OperationsData;
}) {
  const router = useRouter();
  const [data, setData] = useState(initialData);
  const [latestRun, setLatestRun] = useState<OperationRun | null>(
    initialData.run ?? null,
  );
  const [running, setRunning] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(
    null,
  );
  const [isRefreshing, startRefresh] = useTransition();
  const operationInFlightRef = useRef(false);
  const outputRef = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmationTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setData(initialData);
    if (initialData.run) setLatestRun(initialData.run);
  }, [initialData]);

  useEffect(() => {
    if (!confirmation) return;
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [confirmation]);

  const busy = Boolean(running) || isRefreshing;
  const blockingChecks = data.preflight.checks.filter((check) => check.blocker);
  const visibleGroups = data.groups.filter((group) => group.actions.length);
  const pm2Available = Boolean(data.tools?.pm2?.available ?? data.pm2Available);
  const canControlPm2 = Boolean(data.permissions?.manage && pm2Available);

  function focusLatestOutput() {
    window.requestAnimationFrame(() => outputRef.current?.focus());
  }

  async function postOperation(
    body: Record<string, unknown>,
    key: string,
    successMessage: string,
  ) {
    if (operationInFlightRef.current) return;
    operationInFlightRef.current = true;
    setRunning(key);
    try {
      const response = await fetch(
        `/api/sites/${encodeURIComponent(domain)}/sections/actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const result = (await response
        .json()
        .catch(() => null)) as ApiResponse | null;
      if (!response.ok || !result?.success || !result.data) {
        throw new Error(
          result?.error?.message || "The operation could not be executed.",
        );
      }

      setData(result.data);
      const outcome = result.data.run;
      if (outcome) {
        setLatestRun(outcome);
        focusLatestOutput();
      }
      if (outcome?.timedOut) {
        toast.error("The operation was stopped after its time limit.");
      } else if (outcome && outcome.exitCode !== 0) {
        toast.error(`Operation finished with exit code ${outcome.exitCode}.`);
      } else {
        toast.success(successMessage);
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The operation could not be executed.",
      );
      window.requestAnimationFrame(() =>
        confirmationTriggerRef.current?.focus(),
      );
    } finally {
      operationInFlightRef.current = false;
      setRunning(null);
    }
  }

  function runAction(action: OperationAction) {
    const key = actionKey(action);
    void postOperation(
      { action: "run", command: action.id, ...(action.input ?? {}) },
      key,
      `${action.label} completed`,
    );
  }

  function requestAction(action: OperationAction, trigger: HTMLButtonElement) {
    if (busy || !isActionReady(action.status)) return;
    confirmationTriggerRef.current = trigger;
    if (!action.confirmation) {
      runAction(action);
      return;
    }
    setConfirmation({
      ...action.confirmation,
      variant: action.risk === "destructive" ? "danger" : "default",
      run: () => runAction(action),
    });
  }

  function deploy(plan: DeploymentPlan) {
    void postOperation(
      { action: "deploy", plan: plan.id },
      `deploy:${plan.id}`,
      `${plan.label} completed`,
    );
  }

  function requestDeploy(plan: DeploymentPlan, trigger: HTMLButtonElement) {
    if (busy || plan.status !== "ready") return;
    confirmationTriggerRef.current = trigger;
    if (!plan.confirmation) {
      deploy(plan);
      return;
    }
    setConfirmation({
      ...plan.confirmation,
      variant: plan.risk === "destructive" ? "danger" : "default",
      run: () => deploy(plan),
    });
  }

  function requestPm2Action(
    command: "pm2-restart-one" | "pm2-stop-one" | "pm2-delete-one",
    name: string,
    trigger: HTMLButtonElement,
  ) {
    if (busy || !canControlPm2) return;
    confirmationTriggerRef.current = trigger;
    const run = () =>
      void postOperation(
        { action: "run", command, name },
        `${command}:${name}`,
        `${name} updated`,
      );
    if (command === "pm2-restart-one") {
      run();
      return;
    }
    const deleting = command === "pm2-delete-one";
    setConfirmation({
      title: deleting ? `Delete ${name} from PM2?` : `Stop ${name}?`,
      message: deleting
        ? "The process will stop and be removed from this site's PM2 process list. Application files are not deleted."
        : "The process will stop and the website may become unavailable until it is started again.",
      confirmText: deleting ? "Delete process" : "Stop process",
      variant: "danger",
      run,
    });
  }

  function closeConfirmation(returnFocus: boolean) {
    setConfirmation(null);
    if (returnFocus) {
      window.requestAnimationFrame(() =>
        confirmationTriggerRef.current?.focus(),
      );
    }
  }

  const architecture = data.architecture.primary;
  const readiness = STATUS[data.preflight.status];
  const ReadinessIcon = readiness.icon;

  return (
    <div
      className="space-y-5"
      aria-busy={busy}
      aria-live={isRefreshing ? "polite" : "off"}
    >
      <section
        className={cn(
          "overflow-hidden rounded-2xl border bg-white/75 shadow-card backdrop-blur-md",
          readiness.panel,
        )}
        aria-labelledby="operations-readiness-title"
      >
        <div className="grid gap-5 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.72fr)]">
          <div className="min-w-0">
            <div className="flex items-start gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white text-panel-600 shadow-sm ring-1 ring-slate-200/80">
                <Workflow className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  Detected architecture
                </p>
                <h3
                  id="operations-readiness-title"
                  className="mt-0.5 text-lg font-bold text-ink"
                >
                  {architecture.label}
                </h3>
                <p className="mt-1 text-sm text-slate-600">
                  {architecture.evidence.length
                    ? `Detected from ${architecture.evidence.join(", ")}.`
                    : "Detected from the website configuration."}
                </p>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-white/80 px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-inset ring-slate-300/80">
                {humanize(data.type)}
              </span>
              <span className="rounded-full bg-white/80 px-2.5 py-1 text-xs font-semibold capitalize text-slate-600 ring-1 ring-inset ring-slate-300/80">
                {architecture.confidence} confidence
              </span>
              {architecture.framework && (
                <span className="inline-flex items-center gap-1 rounded-full bg-panel-50 px-2.5 py-1 text-xs font-semibold text-panel-700 ring-1 ring-inset ring-panel-600/20">
                  <Zap className="h-3 w-3" aria-hidden="true" />
                  {architecture.framework}
                </span>
              )}
            </div>
            <code className="mt-3 block truncate rounded-lg bg-white/70 px-3 py-2 text-xs text-slate-600 ring-1 ring-inset ring-slate-200">
              {data.path}
            </code>
            {data.architecture.alternatives.length > 0 && (
              <p className="mt-3 text-xs text-slate-500">
                Also detected:{" "}
                {data.architecture.alternatives
                  .map((item) => item.label)
                  .join(", ")}
              </p>
            )}
          </div>

          <div className="rounded-xl bg-white/75 p-4 ring-1 ring-inset ring-white/80">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  Deployment readiness
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <ReadinessIcon
                    className={cn(
                      "h-5 w-5",
                      data.preflight.status === "ready"
                        ? "text-emerald-600"
                        : data.preflight.status === "warning"
                          ? "text-amber-600"
                          : "text-red-600",
                    )}
                    aria-hidden="true"
                  />
                  <span className="font-bold text-ink">{readiness.label}</span>
                </div>
              </div>
              <StatusBadge status={data.preflight.status} />
            </div>
            <p className="mt-3 text-sm text-slate-600">
              {blockingChecks.length
                ? `${blockingChecks.length} blocking check${blockingChecks.length === 1 ? "" : "s"} must be resolved before the recommended deployment can run.`
                : data.preflight.status === "warning"
                  ? "Review and resolve the warnings, then refresh before deploying."
                  : "The detected deployment path passed its required checks."}
            </p>
            <p className="mt-3 text-xs text-slate-500">
              Checked{" "}
              <time dateTime={data.preflight.checkedAt}>
                {formatCheckedAt(data.preflight.checkedAt)} UTC
              </time>
            </p>
          </div>
        </div>
      </section>

      <section
        className="rounded-2xl border border-white/60 bg-white/75 p-5 shadow-card backdrop-blur-md sm:p-6"
        aria-labelledby="preflight-title"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 id="preflight-title" className="font-bold text-ink">
              Preflight checks
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              Server-verified requirements for this website and deployment path.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            aria-label="Refresh operations preflight"
            aria-busy={isRefreshing}
            onClick={() => startRefresh(() => router.refresh())}
          >
            {isRefreshing ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            )}
            Refresh preflight
          </Button>
        </div>

        <ul className="mt-5 grid gap-3 md:grid-cols-2">
          {data.preflight.checks.map((check) => {
            const metadata = STATUS[check.status];
            const CheckIcon = metadata.icon;
            return (
              <li
                key={check.id}
                className={cn("rounded-xl border p-4", metadata.panel)}
              >
                <div className="flex items-start gap-3">
                  <CheckIcon
                    className={cn(
                      "mt-0.5 h-5 w-5 shrink-0",
                      check.status === "ready"
                        ? "text-emerald-600"
                        : check.status === "warning"
                          ? "text-amber-600"
                          : "text-red-600",
                    )}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <h4 className="text-sm font-bold text-ink">
                        {check.label}
                      </h4>
                      <StatusBadge status={check.status} />
                    </div>
                    <p className="mt-1.5 text-sm text-slate-600">
                      {check.detail}
                    </p>
                    {check.remediation && check.status !== "ready" && (
                      <div className="mt-3 rounded-lg bg-white/80 px-3 py-2 text-xs text-slate-700 ring-1 ring-inset ring-slate-200/80">
                        <span className="font-bold">How to fix:</span>{" "}
                        {check.remediation}
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {data.plan ? (
        <section
          className="border-panel-200/70 rounded-2xl border bg-gradient-to-br from-panel-50/80 to-white/80 p-5 shadow-card sm:p-6"
          aria-labelledby="deployment-plan-title"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl">
              <p className="text-xs font-bold uppercase tracking-wider text-panel-600">
                Recommended plan
              </p>
              <h3
                id="deployment-plan-title"
                className="mt-1 text-lg font-bold text-ink"
              >
                {data.plan.label}
              </h3>
              <p className="mt-1 text-sm text-slate-600">
                {data.plan.description}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <StatusBadge status={data.plan.status} />
                <span className="rounded-full bg-white/80 px-2.5 py-1 text-xs font-semibold capitalize text-slate-600 ring-1 ring-inset ring-slate-300/80">
                  {humanize(data.plan.risk)} risk
                </span>
                <span className="rounded-full bg-white/80 px-2.5 py-1 text-xs font-semibold capitalize text-slate-600 ring-1 ring-inset ring-slate-300/80">
                  {humanize(data.plan.scope)} scope
                </span>
              </div>
            </div>
            <div className="flex max-w-xs flex-col items-start gap-2 sm:items-end">
              <Button
                type="button"
                disabled={busy || data.plan.status !== "ready"}
                aria-busy={running === `deploy:${data.plan.id}`}
                aria-describedby={
                  data.plan.status !== "ready"
                    ? "deployment-plan-disabled-reason"
                    : undefined
                }
                onClick={(event: ReactMouseEvent<HTMLButtonElement>) =>
                  requestDeploy(data.plan!, event.currentTarget)
                }
              >
                {running === `deploy:${data.plan.id}` ? (
                  <LoaderCircle
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Play className="h-4 w-4" aria-hidden="true" />
                )}
                Deploy now
              </Button>
              {data.plan.status !== "ready" && (
                <p
                  id="deployment-plan-disabled-reason"
                  className="text-xs leading-5 text-slate-600 sm:text-right"
                >
                  {data.plan.status === "warning"
                    ? "Deployment stays disabled until every required preflight check reports Ready."
                    : data.plan.status === "unauthorized"
                      ? "Deployment requires Operations management permission."
                      : "Resolve the blockers below, then refresh the preflight."}
                </p>
              )}
            </div>
          </div>

          <ol className="mt-5 grid gap-3 lg:grid-cols-3">
            {data.plan.steps.map((step, index) => (
              <li
                key={`${step.command}:${index}`}
                className="rounded-xl border border-white/80 bg-white/75 p-4"
              >
                <div className="flex items-start gap-3">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-panel-100 text-xs font-bold text-panel-700">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <h4 className="text-sm font-bold text-ink">{step.label}</h4>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      {step.description}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ol>

          {data.plan.warnings.length > 0 && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/80 p-4 text-sm text-amber-900">
              <div className="flex items-center gap-2 font-bold">
                <TriangleAlert className="h-4 w-4" aria-hidden="true" />
                Review before deploying
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {data.plan.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          {data.plan.blockedBy.length > 0 && (
            <div
              id="deployment-plan-blockers"
              className="mt-4 rounded-xl border border-red-200 bg-red-50/85 p-4 text-sm text-red-900"
            >
              <div className="flex items-center gap-2 font-bold">
                <CircleX className="h-4 w-4" aria-hidden="true" />
                Deployment is blocked
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {data.plan.blockedBy.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      ) : (
        <section className="rounded-2xl border border-slate-200 bg-white/75 p-5 shadow-card sm:p-6">
          <div className="flex items-start gap-3">
            <CircleHelp
              className="mt-0.5 h-5 w-5 shrink-0 text-slate-400"
              aria-hidden="true"
            />
            <div>
              <h3 className="font-bold text-ink">
                No automatic deployment plan
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                Panelavo will not guess a start command or document root for
                this architecture. Safe detected actions remain available below.
              </p>
            </div>
          </div>
        </section>
      )}

      {data.pm2?.length ? (
        <section
          className="rounded-2xl border border-white/60 bg-white/75 p-5 shadow-card backdrop-blur-md sm:p-6"
          aria-labelledby="pm2-processes-title"
        >
          <div>
            <h3 id="pm2-processes-title" className="font-bold text-ink">
              PM2 processes
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              Live process state owned by this website&apos;s system user.
            </p>
          </div>
          {!canControlPm2 && (
            <p
              id="pm2-controls-unavailable"
              className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-inset ring-amber-200"
            >
              {!pm2Available
                ? "PM2 controls are disabled because PM2 is unavailable."
                : "PM2 controls require Operations management permission."}
            </p>
          )}
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.pm2.map((process) => {
              const online = process.status.toLowerCase() === "online";
              return (
                <article
                  key={process.name}
                  className="rounded-xl border border-slate-200/80 bg-white/80 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h4 className="truncate font-bold text-ink">
                        {process.name}
                      </h4>
                      <span
                        className={cn(
                          "mt-1 inline-flex rounded-full px-2 py-0.5 text-xs font-semibold",
                          online
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-red-50 text-red-700",
                        )}
                      >
                        {process.status}
                      </span>
                    </div>
                    <Boxes
                      className="h-5 w-5 shrink-0 text-slate-300"
                      aria-hidden="true"
                    />
                  </div>
                  <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-lg bg-slate-50 px-2 py-2">
                      <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                        CPU
                      </dt>
                      <dd className="mt-0.5 text-sm font-semibold text-slate-700">
                        {process.cpu}%
                      </dd>
                    </div>
                    <div className="rounded-lg bg-slate-50 px-2 py-2">
                      <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                        Memory
                      </dt>
                      <dd className="mt-0.5 text-sm font-semibold text-slate-700">
                        {formatBytes(process.memory)}
                      </dd>
                    </div>
                    <div className="rounded-lg bg-slate-50 px-2 py-2">
                      <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                        Restarts
                      </dt>
                      <dd className="mt-0.5 text-sm font-semibold text-slate-700">
                        {process.restarts}
                      </dd>
                    </div>
                  </dl>
                  <div className="mt-4 grid grid-cols-3 gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="px-2"
                      disabled={busy || !canControlPm2}
                      aria-label={`Restart ${process.name}`}
                      aria-busy={running === `pm2-restart-one:${process.name}`}
                      aria-describedby={
                        !canControlPm2 ? "pm2-controls-unavailable" : undefined
                      }
                      onClick={(event) =>
                        requestPm2Action(
                          "pm2-restart-one",
                          process.name,
                          event.currentTarget,
                        )
                      }
                    >
                      {running === `pm2-restart-one:${process.name}` ? (
                        <LoaderCircle
                          className="h-4 w-4 animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <RotateCcw className="h-4 w-4" aria-hidden="true" />
                      )}
                      <span className="sr-only sm:not-sr-only">Restart</span>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="px-2"
                      disabled={busy || !canControlPm2}
                      aria-label={`Stop ${process.name}`}
                      aria-busy={running === `pm2-stop-one:${process.name}`}
                      aria-describedby={
                        !canControlPm2 ? "pm2-controls-unavailable" : undefined
                      }
                      onClick={(event) =>
                        requestPm2Action(
                          "pm2-stop-one",
                          process.name,
                          event.currentTarget,
                        )
                      }
                    >
                      {running === `pm2-stop-one:${process.name}` ? (
                        <LoaderCircle
                          className="h-4 w-4 animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <Square className="h-4 w-4" aria-hidden="true" />
                      )}
                      <span className="sr-only sm:not-sr-only">Stop</span>
                    </Button>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      className="px-2"
                      disabled={busy || !canControlPm2}
                      aria-label={`Delete ${process.name} from PM2`}
                      aria-busy={running === `pm2-delete-one:${process.name}`}
                      aria-describedby={
                        !canControlPm2 ? "pm2-controls-unavailable" : undefined
                      }
                      onClick={(event) =>
                        requestPm2Action(
                          "pm2-delete-one",
                          process.name,
                          event.currentTarget,
                        )
                      }
                    >
                      {running === `pm2-delete-one:${process.name}` ? (
                        <LoaderCircle
                          className="h-4 w-4 animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      )}
                      <span className="sr-only sm:not-sr-only">Delete</span>
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {visibleGroups.map((group) => (
        <section
          key={group.id}
          className="rounded-2xl border border-white/60 bg-white/75 p-5 shadow-card backdrop-blur-md sm:p-6"
          aria-labelledby={`operation-group-${htmlId(group.id)}`}
        >
          <div>
            <h3
              id={`operation-group-${htmlId(group.id)}`}
              className="font-bold text-ink"
            >
              {group.title}
            </h3>
            <p className="mt-1 text-sm text-slate-500">{group.description}</p>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {group.actions.map((action) => {
              const key = actionKey(action);
              const reasonId = `operation-${htmlId(group.id)}-${htmlId(key)}-reason`;
              const Icon = ICONS[action.iconKey];
              const runnable = isActionReady(action.status);
              const actionBusy = running === key;
              return (
                <button
                  key={key}
                  type="button"
                  disabled={busy || !runnable}
                  aria-busy={actionBusy}
                  aria-describedby={!runnable ? reasonId : undefined}
                  onClick={(event) =>
                    requestAction(action, event.currentTarget)
                  }
                  className={cn(
                    "group flex min-h-36 flex-col rounded-xl border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-panel-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed",
                    action.risk === "destructive"
                      ? "border-red-200/80 bg-red-50/45 enabled:hover:bg-red-50"
                      : "enabled:hover:border-panel-300 border-slate-200/80 bg-white/75 enabled:hover:bg-panel-50/45",
                    !runnable && "opacity-75",
                  )}
                >
                  <span className="flex w-full items-start gap-3">
                    <span
                      className={cn(
                        "grid h-9 w-9 shrink-0 place-items-center rounded-lg",
                        action.risk === "destructive"
                          ? "bg-red-100 text-red-600"
                          : "bg-panel-50 text-panel-600",
                      )}
                    >
                      {actionBusy ? (
                        <LoaderCircle
                          className="h-4 w-4 animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <Icon className="h-4 w-4" aria-hidden="true" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-start justify-between gap-2">
                        <span
                          className={cn(
                            "font-bold",
                            action.risk === "destructive"
                              ? "text-red-800"
                              : "text-ink",
                          )}
                        >
                          {action.label}
                        </span>
                        <StatusBadge status={action.status} />
                      </span>
                      <span className="mt-1 block text-sm leading-5 text-slate-500">
                        {action.description}
                      </span>
                    </span>
                  </span>

                  <span className="mt-auto block w-full pt-3">
                    {action.commandPreview && (
                      <code className="block truncate rounded-md bg-slate-950/[0.04] px-2 py-1 text-xs text-slate-600">
                        {action.commandPreview}
                      </code>
                    )}
                    <span className="mt-2 flex flex-wrap gap-1.5 text-[11px] font-semibold capitalize text-slate-400">
                      <span>{humanize(action.scope)}</span>
                      <span aria-hidden="true">&middot;</span>
                      <span>{humanize(action.risk)} risk</span>
                      {action.confirmation && (
                        <>
                          <span aria-hidden="true">&middot;</span>
                          <span>confirmation required</span>
                        </>
                      )}
                    </span>
                    {!runnable && (
                      <span
                        id={reasonId}
                        className="mt-2 block rounded-lg bg-red-50 px-2.5 py-2 text-xs leading-5 text-red-700"
                      >
                        <span className="font-bold">Unavailable:</span>{" "}
                        {action.blockedBy.length
                          ? action.blockedBy.join(" ")
                          : `${STATUS[action.status].label} in the current capability report.`}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}

      {!visibleGroups.length && (
        <section className="rounded-2xl border border-dashed border-slate-300 bg-white/65 p-8 text-center">
          {blockingChecks.length || data.preflight.status === "unauthorized" ? (
            <>
              <ShieldAlert
                className="mx-auto h-9 w-9 text-amber-500"
                aria-hidden="true"
              />
              <h3 className="mt-3 font-bold text-ink">
                Operations need attention
              </h3>
              <p className="mx-auto mt-1 max-w-2xl text-sm text-slate-500">
                The architecture was detected, but its operations cannot be
                offered until the blocking preflight checks above are resolved.
              </p>
            </>
          ) : (
            <>
              <CircleHelp
                className="mx-auto h-9 w-9 text-slate-300"
                aria-hidden="true"
              />
              <h3 className="mt-3 font-bold text-ink">
                No managed actions for this architecture
              </h3>
              <p className="mx-auto mt-1 max-w-2xl text-sm text-slate-500">
                Panelavo found the website but did not detect a safe, explicit
                operation it can run. Add a supported manifest or process
                declaration, then refresh the preflight.
              </p>
            </>
          )}
        </section>
      )}

      {latestRun && (
        <section
          ref={outputRef}
          role="log"
          aria-live="polite"
          aria-label="Latest operation output"
          tabIndex={-1}
          className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card focus:outline-none focus-visible:ring-2 focus-visible:ring-panel-500 focus-visible:ring-offset-2"
        >
          <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Latest operation
              </p>
              <h3 className="mt-0.5 font-bold text-ink">Command output</h3>
              <code className="mt-1 block max-w-full truncate text-xs text-slate-500">
                {latestRun.display}
              </code>
            </div>
            <span
              className={cn(
                "shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset",
                runStatus(latestRun).className,
              )}
            >
              {runStatus(latestRun).label}
            </span>
          </div>

          {latestRun.steps?.length ? (
            <ol className="grid gap-3 border-b bg-slate-50/70 p-4 md:grid-cols-2 xl:grid-cols-3">
              {latestRun.steps.map((step, index) => {
                const succeeded = !step.timedOut && step.exitCode === 0;
                const StepIcon = step.timedOut
                  ? TriangleAlert
                  : succeeded
                    ? CircleCheck
                    : CircleX;
                return (
                  <li
                    key={`${step.command}:${index}`}
                    className="rounded-lg border border-slate-200 bg-white p-3"
                  >
                    <div className="flex items-start gap-2.5">
                      <StepIcon
                        className={cn(
                          "mt-0.5 h-4 w-4 shrink-0",
                          step.timedOut
                            ? "text-amber-600"
                            : succeeded
                              ? "text-emerald-600"
                              : "text-red-600",
                        )}
                        aria-hidden="true"
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-ink">
                          {step.label}
                        </p>
                        <p className="mt-0.5 text-xs font-semibold text-slate-500">
                          {step.timedOut
                            ? "Timed out"
                            : succeeded
                              ? "Completed"
                              : `Failed with exit code ${step.exitCode}`}
                        </p>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : null}

          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words bg-slate-950 p-5 font-mono text-xs leading-5 text-slate-200">
            {latestRun.output || "The operation produced no output."}
          </pre>
        </section>
      )}

      {confirmation && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={confirmation.title}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              closeConfirmation(true);
              return;
            }
            if (event.key !== "Tab") return;
            const buttons = Array.from(
              dialogRef.current?.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              ) ?? [],
            );
            const first = buttons.at(0);
            const last = buttons.at(-1);
            if (!first || !last) return;
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }}
        >
          <ConfirmDialog
            title={confirmation.title}
            message={confirmation.message}
            confirmText={confirmation.confirmText}
            variant={confirmation.variant}
            onCancel={() => closeConfirmation(true)}
            onConfirm={() => {
              const run = confirmation.run;
              closeConfirmation(false);
              run();
            }}
          />
        </div>
      )}
    </div>
  );
}
