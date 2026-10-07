"use client";
import { DeploymentManager } from "@/components/sites/deployment-manager";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  Boxes,
  CircleCheck,
  CircleHelp,
  CircleX,
  Container,
  Database,
  Eye,
  EyeOff,
  FileCog,
  Hammer,
  Layers3,
  LoaderCircle,
  Network,
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
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type {
  OperationAction,
  OperationFix,
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

const WORKFLOW_STEPS = [
  "Review website",
  "Prepare",
  "Deploy",
  "Verify",
] as const;

const WORKSPACE_TABS = [
  ["deployment", "Deployment"],
  ["runtime", "Runtime"],
  ["advanced", "Advanced tools"],
  ["jobs", "Scheduled jobs"],
  ["logs", "Logs"],
] as const;

type WorkspaceTab = (typeof WORKSPACE_TABS)[number][0];

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatUptime(seconds: number) {
  if (!seconds || seconds < 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
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
  apiBase = "",
  scheduledJobs,
  logs,
}: {
  domain: string;
  initialData: OperationsData;
  apiBase?: string;
  scheduledJobs?: React.ReactNode;
  logs?: React.ReactNode;
}) {
  const router = useRouter();
  const [data, setData] = useState(initialData);
  const [workflowStep, setWorkflowStep] = useState(0);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("deployment");
  const [openedWorkspaceTabs, setOpenedWorkspaceTabs] = useState<
    Set<WorkspaceTab>
  >(() => new Set(["deployment"]));
  const [showPassedChecks, setShowPassedChecks] = useState(false);
  const [latestRun, setLatestRun] = useState<OperationRun | null>(
    initialData.run ?? null,
  );
  const [running, setRunning] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(
    null,
  );
  const [envFixValues, setEnvFixValues] = useState<Record<
    string,
    string
  > | null>(null);
  const [showEnvFixValues, setShowEnvFixValues] = useState(false);
  const [savingEnvFix, setSavingEnvFix] = useState(false);
  const envFixRef = useDialogFocus(() => {
    if (!savingEnvFix) setEnvFixValues(null);
  }, Boolean(envFixValues));
  const [isRefreshing, startRefresh] = useTransition();
  const operationInFlightRef = useRef(false);
  const outputRef = useRef<HTMLElement>(null);
  const confirmationTriggerRef = useRef<HTMLButtonElement | null>(null);
  const workflowHeadingRef = useRef<HTMLHeadingElement>(null);
  const workspaceTabRefs = useRef<
    Record<WorkspaceTab, HTMLButtonElement | null>
  >({
    deployment: null,
    runtime: null,
    advanced: null,
    jobs: null,
    logs: null,
  });

  const hasScheduledJobs = Boolean(scheduledJobs);
  const hasLogs = Boolean(logs);
  const visibleWorkspaceTabs = useMemo(
    () =>
      WORKSPACE_TABS.filter(([value]) => {
        if (value === "jobs") return hasScheduledJobs;
        if (value === "logs") return hasLogs;
        return true;
      }),
    [hasLogs, hasScheduledJobs],
  );

  useEffect(() => {
    const syncLocation = (resetOpened: boolean) => {
      const params = new URLSearchParams(window.location.search);
      const value = Number(params.get("step"));
      setWorkflowStep(
        Number.isInteger(value) && value >= 1 && value <= 4 ? value - 1 : 0,
      );
      const requestedTab = params.get("tab") as WorkspaceTab | null;
      const resolvedTab =
        requestedTab && visibleWorkspaceTabs.some(([tab]) => tab === requestedTab)
          ? requestedTab
          : "deployment";
      setWorkspaceTab(resolvedTab);
      setOpenedWorkspaceTabs((current) => {
        if (resetOpened) return new Set(["deployment", resolvedTab]);
        if (current.has(resolvedTab)) return current;
        const next = new Set(current);
        next.add(resolvedTab);
        return next;
      });
    };
    const syncHistory = () => syncLocation(false);
    syncLocation(true);
    window.addEventListener("popstate", syncHistory);
    return () => window.removeEventListener("popstate", syncHistory);
  }, [domain, apiBase, visibleWorkspaceTabs]);

  function chooseWorkspaceTab(value: WorkspaceTab, focus = false) {
    if (workspaceTab !== value) {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", value);
      window.history.pushState(null, "", url);
    }
    setWorkspaceTab(value);
    setOpenedWorkspaceTabs((current) => {
      if (current.has(value)) return current;
      const next = new Set(current);
      next.add(value);
      return next;
    });
    if (focus) {
      window.requestAnimationFrame(() =>
        workspaceTabRefs.current[value]?.focus(),
      );
    }
  }

  function moveWorkspaceTab(
    event: React.KeyboardEvent<HTMLButtonElement>,
    current: WorkspaceTab,
  ) {
    const currentIndex = visibleWorkspaceTabs.findIndex(
      ([tab]) => tab === current,
    );
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight")
      nextIndex = (currentIndex + 1) % visibleWorkspaceTabs.length;
    if (event.key === "ArrowLeft")
      nextIndex =
        (currentIndex - 1 + visibleWorkspaceTabs.length) %
        visibleWorkspaceTabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = visibleWorkspaceTabs.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    chooseWorkspaceTab(visibleWorkspaceTabs[nextIndex][0], true);
  }

  function chooseWorkflowStep(value: number) {
    const url = new URL(window.location.href);
    url.searchParams.set("step", String(value + 1));
    window.history.pushState(null, "", url);
    setWorkflowStep(value);
    window.requestAnimationFrame(() => workflowHeadingRef.current?.focus());
  }

  useEffect(() => {
    setData(initialData);
    if (initialData.run) setLatestRun(initialData.run);
  }, [initialData]);

  const refreshAfterDeployment = useCallback(() => router.refresh(), [router]);

  const busy = Boolean(running) || isRefreshing;
  const blockingChecks = data.preflight.checks.filter((check) => check.blocker);
  const visibleGroups = data.groups.filter((group) => group.actions.length);
  const pm2Available = Boolean(data.tools?.pm2?.available ?? data.pm2Available);
  const canControlPm2 = Boolean(data.permissions?.manage && pm2Available);
  const missingEnvVariables = data.compose?.missingEnvVariables ?? [];

  function openEnvFix() {
    setEnvFixValues(
      Object.fromEntries(missingEnvVariables.map((key) => [key, ""])),
    );
    setShowEnvFixValues(false);
  }

  async function saveEnvFix(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!envFixValues || savingEnvFix) return;
    const entries = Object.entries(envFixValues).map(([key, value]) => ({
      key,
      value: value.trim(),
    }));
    if (entries.some((entry) => !entry.value)) return;
    setSavingEnvFix(true);
    try {
      const response = await fetch(
        `${apiBase}/api/sites/${encodeURIComponent(domain)}/sections/env`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "upsert", entries }),
        },
      );
      const result = (await response.json().catch(() => null)) as {
        success?: boolean;
        error?: { message?: string };
      } | null;
      if (!response.ok || !result?.success)
        throw new Error(
          result?.error?.message || "The values could not be saved.",
        );
      setEnvFixValues(null);
      toast.success("Missing environment values saved to .env.");
      startRefresh(() => router.refresh());
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The values could not be saved.",
      );
    } finally {
      setSavingEnvFix(false);
    }
  }

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
        `${apiBase}/api/sites/${encodeURIComponent(domain)}/sections/actions`,
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
        chooseWorkspaceTab("advanced");
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

  function requestFix(fix: OperationFix, trigger: HTMLButtonElement) {
    if (busy || fix.status !== "ready") return;
    confirmationTriggerRef.current = trigger;
    const run = () =>
      void postOperation(
        { action: "fix", fix: fix.id },
        `fix:${fix.id}`,
        `${fix.label} completed`,
      );
    if (!fix.confirmation) {
      run();
      return;
    }
    setConfirmation({
      ...fix.confirmation,
      variant: fix.risk === "destructive" ? "danger" : "default",
      run,
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
  const runtime = data.runtime;
  const hasRuntime = Boolean(
    data.pm2?.length ||
    runtime?.containers?.length ||
    runtime?.listeners?.length ||
    data.compose?.rootless,
  );
  const restartAction = data.groups
    .flatMap((group) => group.actions)
    .find(
      (action) =>
        action.id === (data.hasCompose ? "compose-restart" : "pm2-start"),
    );
  const envDrift = (runtime?.env ?? []).filter(
    (item) => item.status === "differs" || item.status === "missing",
  );
  const traffic = data.port;
  const trafficFix = data.preflight.checks.find(
    (item) => item.id === "runtime-port" || item.id === "upstream-port",
  )?.fix;
  const trafficTone =
    traffic?.inspectionAvailable === false
      ? "border-amber-200 bg-amber-50 text-amber-800"
      : traffic?.listening
        ? "border-emerald-200 bg-emerald-50 text-emerald-800"
        : traffic?.conflict
          ? "border-red-200 bg-red-50 text-red-700"
          : "border-amber-200 bg-amber-50 text-amber-800";
  const siteBase = `${apiBase ? apiBase.replace(/^\/api\/fleet\/servers\//, "/servers/").replace(/\/proxy$/, "") : ""}/sites/${encodeURIComponent(domain)}`;
  const deploymentBlocked = blockingChecks.length
    ? `${blockingChecks.map((check) => check.label).join(", ")} must be resolved in Prepare.`
    : !data.plan
      ? "No automated deployment plan is available for this website. Review the detected files and website type."
      : !isActionReady(data.plan.status)
        ? data.plan.blockedBy.join(" ") ||
          "The suggested deployment plan is not ready."
        : undefined;

  return (
    <div
      className="space-y-5"
      aria-busy={busy}
      aria-live={isRefreshing ? "polite" : "off"}
    >
      <div
        role="tablist"
        aria-label="Operations workspace"
        className="flex gap-1 overflow-x-auto rounded-2xl border border-slate-200 bg-slate-100/70 p-1"
      >
        {visibleWorkspaceTabs.map(([value, label]) => (
          <button
            key={value}
            ref={(element) => {
              workspaceTabRefs.current[value] = element;
            }}
            type="button"
            role="tab"
            id={`operations-tab-${value}`}
            aria-selected={workspaceTab === value}
            aria-controls={`operations-panel-${value}`}
            tabIndex={workspaceTab === value ? 0 : -1}
            onClick={() => chooseWorkspaceTab(value)}
            onKeyDown={(event) => moveWorkspaceTab(event, value)}
            className={cn(
              "min-h-10 shrink-0 rounded-xl px-4 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-panel-500",
              workspaceTab === value
                ? "bg-white text-panel-700 shadow-sm"
                : "text-slate-600 hover:bg-white/70 hover:text-slate-900",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="operations-panel-deployment"
        aria-labelledby="operations-tab-deployment"
        hidden={workspaceTab !== "deployment"}
        className="space-y-5"
      >
      <nav
        aria-label="Deployment steps"
        className="rounded-2xl border border-slate-200 bg-white p-2 shadow-card"
      >
        <ol className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {WORKFLOW_STEPS.map((label, index) => (
            <li key={label}>
              <button
                type="button"
                disabled={busy}
                aria-current={workflowStep === index ? "step" : undefined}
                onClick={() => chooseWorkflowStep(index)}
                className={cn(
                  "flex min-h-12 w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-panel-500 disabled:opacity-60",
                  workflowStep === index
                    ? "ring-panel-200 bg-panel-50 text-panel-700 ring-1"
                    : "text-slate-600 hover:bg-slate-50",
                )}
              >
                <span
                  className={cn(
                    "grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs",
                    workflowStep === index
                      ? "bg-panel-600 text-white"
                      : "bg-slate-100 text-slate-500",
                  )}
                >
                  {index + 1}
                </span>
                {label}
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <section
        aria-label="Current deployment step"
        className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card sm:p-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-panel-700">
              Step {workflowStep + 1} of 4
            </p>
            <h3
              ref={workflowHeadingRef}
              tabIndex={-1}
              className="mt-1 text-xl font-bold text-ink focus:outline-none"
            >
              {WORKFLOW_STEPS[workflowStep]}
            </h3>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              {workflowStep === 0
                ? "Confirm what Panelavo found and where your application lives. Rechecking never changes your files."
                : workflowStep === 1
                  ? "Resolve the requirements below. Suggested repairs run only after you choose them; advanced commands stay separate."
                  : workflowStep === 2
                    ? "Review the server’s suggested plan and deploy the files already on this website. Connect Git if you need to fetch a newer version first."
                    : "Check the running application and traffic alignment, then open the website to confirm the pages work. A running process alone does not prove the website is healthy."}
            </p>
          </div>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => startRefresh(() => router.refresh())}
            aria-label="Recheck website"
          >
            <RefreshCw
              className={cn("h-4 w-4", isRefreshing && "animate-spin")}
              aria-hidden="true"
            />
            Recheck website
          </Button>
        </div>
      </section>
      <div hidden={workflowStep !== 0} className="space-y-5">
        <section
          aria-label="Website detection"
          className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card sm:p-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-lg font-bold text-ink">{architecture.label}</h3>
            <StatusBadge status={data.preflight.status} />
          </div>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {data.guidance?.summary ??
              `Detected from ${architecture.evidence.join(", ") || "the configured website type"}.`}
          </p>
          <dl className="mt-4 space-y-3 text-sm">
            <div>
              <dt className="font-semibold text-slate-700">
                Application folder
              </dt>
              <dd className="mt-1 break-all font-mono text-xs text-slate-600">
                {data.path || "Not resolved"}
              </dd>
            </div>
            {data.structure?.servingRoot && (
              <div>
                <dt className="font-semibold text-slate-700">
                  Public document root
                </dt>
                <dd className="mt-1 break-all font-mono text-xs text-slate-600">
                  {data.structure.servingRoot}
                </dd>
              </div>
            )}
            {(data.assignedPort || traffic?.expected) && (
              <div>
                <dt className="font-semibold text-slate-700">
                  {data.assignedPort
                    ? "Assigned application port"
                    : "Configured application port"}
                </dt>
                <dd className="mt-1 text-slate-600">
                  {data.assignedPort ?? traffic?.expected}
                  {data.assignedPort &&
                  traffic?.expected &&
                  data.assignedPort !== traffic.expected
                    ? ` · current custom or legacy proxy: ${traffic.expected}`
                    : ""}
                </dd>
              </div>
            )}
          </dl>
          {data.structure?.candidates.length ? (
            <details className="mt-4 rounded-xl border border-slate-200 p-3">
              <summary className="cursor-pointer text-sm font-semibold">
                Other application folders found
              </summary>
              <ul className="mt-3 space-y-2 text-sm text-slate-600">
                {data.structure.candidates.map((candidate) => (
                  <li key={candidate.path} className="break-words">
                    <span className="font-mono font-semibold">
                      {candidate.path}
                    </span>{" "}
                    · {candidate.kinds.join(" / ")}
                    <span className="block text-xs">
                      {candidate.evidence.join(", ")}
                    </span>
                  </li>
                ))}
              </ul>
              {data.structure.truncated && (
                <p className="mt-2 text-xs text-amber-700">
                  The bounded folder scan reached its limit. Review Files for
                  other application folders.
                </p>
              )}
            </details>
          ) : null}
          <div className="mt-5 flex flex-wrap gap-2">
            <a
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700"
              href={`${siteBase}/file-manager`}
            >
              Review files
            </a>
            <a
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700"
              href={`${siteBase}/settings`}
            >
              Change application folder
            </a>
            <Button disabled={busy} onClick={() => chooseWorkflowStep(1)}>
              Continue to Prepare
            </Button>
          </div>
        </section>
      </div>
      <div hidden={workflowStep !== 3} className="space-y-5">
        <section
          className="rounded-2xl border bg-white p-5 shadow-card"
          aria-label="Application status"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-bold">Application status</h3>
              <p className="mt-1 text-sm text-slate-600">
                {data.runtime?.containers?.some(
                  (item) =>
                    item.state === "running" && item.health !== "unhealthy",
                ) || data.pm2?.some((item) => item.status === "online")
                  ? "Application is running"
                  : data.port?.inspectionAvailable === false
                    ? "Application runtime could not be verified"
                    : data.port?.listening
                      ? "Application listener is aligned"
                      : ["php", "static"].includes(data.type)
                        ? "Served by the website server"
                        : "Runtime status is unavailable or stopped"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {data.permissions?.manage && restartAction && (
                <Button
                  variant="outline"
                  disabled={busy || !isActionReady(restartAction.status)}
                  onClick={(event) => {
                    if (!data.hasCompose && data.pm2?.length === 1)
                      requestPm2Action(
                        "pm2-restart-one",
                        data.pm2[0].name,
                        event.currentTarget,
                      );
                    else requestAction(restartAction, event.currentTarget);
                  }}
                >
                  <RotateCcw className="h-4 w-4" />
                  Restart application
                </Button>
              )}
              {data.permissions?.manage && logs && (
                <Button
                  variant="outline"
                  onClick={() => chooseWorkspaceTab("logs", true)}
                >
                  <ScrollText className="h-4 w-4" />
                  View logs
                </Button>
              )}
              <a
                className="inline-flex items-center rounded-lg bg-panel-600 px-4 py-2 text-sm font-semibold text-white"
                href={`https://${domain}/`}
                target="_blank"
                rel="noreferrer"
              >
                Open website
              </a>
            </div>
          </div>
        </section>
      </div>
      <div
        hidden={workflowStep !== 1 && workflowStep !== 3}
        className="space-y-5"
      >
        {traffic?.expected && (
          <section
            className="rounded-2xl border bg-white p-5 shadow-card"
            aria-label="Website traffic alignment"
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Network
                    className="h-5 w-5 text-panel-600"
                    aria-hidden="true"
                  />
                  <h3 className="font-bold">Website traffic</h3>
                </div>
                <p className="mt-2 text-sm text-slate-600">
                  CloudPanel sends this website to{" "}
                  <code className="rounded bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-800">
                    127.0.0.1:{traffic.expected}
                  </code>
                  .
                </p>
                <div
                  className={cn(
                    "mt-3 inline-flex rounded-lg border px-3 py-2 text-sm font-semibold",
                    trafficTone,
                  )}
                >
                  {traffic.inspectionAvailable === false
                    ? "Listener check unavailable"
                    : traffic.listening
                      ? "Listener aligned"
                      : traffic.conflict
                        ? "Port conflict"
                        : "Application is not listening on the website port"}
                </div>
                <p className="mt-2 max-w-3xl text-sm text-slate-600">
                  {traffic.detail}
                </p>
                {traffic.detected.length > 0 && !traffic.listening && (
                  <p className="mt-2 text-xs text-slate-500">
                    Site-owned listener
                    {traffic.detected.length === 1 ? "" : "s"}:{" "}
                    {traffic.detected.join(", ")}
                  </p>
                )}
              </div>
              {data.permissions?.manage && trafficFix?.status === "ready" ? (
                <Button
                  type="button"
                  disabled={busy}
                  onClick={(event) =>
                    requestFix(trafficFix, event.currentTarget)
                  }
                >
                  <Zap className="h-4 w-4" aria-hidden="true" />
                  Fix port configuration
                </Button>
              ) : !traffic.listening &&
                traffic.inspectionAvailable !== false ? (
                <a
                  className="inline-flex items-center rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  href={`${apiBase ? apiBase.replace(/^\/api\/fleet\/servers\//, "/servers/").replace(/\/proxy$/, "") : ""}/sites/${encodeURIComponent(domain)}/settings`}
                >
                  Review port settings
                </a>
              ) : null}
            </div>
          </section>
        )}
      </div>
      <div hidden={workflowStep !== 2} className="space-y-5">
        {data.plan && (
          <details open className="rounded-2xl border bg-white p-4">
            <summary className="cursor-pointer text-sm font-medium">
              Suggested deployment steps
            </summary>
            <h3 id="deployment-plan-title" className="mt-3 font-semibold">
              {data.plan.label}
            </h3>
            <ol className="mt-2 list-inside list-decimal space-y-1 text-sm text-slate-600">
              {data.plan.steps.map((step, index) => (
                <li key={index}>{step.label}</li>
              ))}
            </ol>
            {data.plan.warnings.map((warning) => (
              <p key={warning} className="mt-2 text-sm text-amber-700">
                {warning}
              </p>
            ))}
          </details>
        )}
      </div>
      <div
        hidden={workflowStep !== 2 && workflowStep !== 3}
        className="space-y-5"
      >
        <DeploymentManager
          domain={domain}
          apiBase={apiBase}
          canWrite={Boolean(data.permissions?.manage)}
          source="current"
          compact
          onFinished={refreshAfterDeployment}
          blockedReason={deploymentBlocked}
        />
        {workflowStep === 2 && (
          <div className="flex flex-wrap gap-2">
            <a
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700"
              href={`${siteBase}/git`}
            >
              Connect or update Git
            </a>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => chooseWorkflowStep(3)}
            >
              Continue to Verify
            </Button>
          </div>
        )}
      </div>
      <div hidden={workflowStep !== 1} className="space-y-5">
        {envDrift.length > 0 && (
          <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-800">
            Application environment changed.{" "}
            {data.hasCompose
              ? "Deploy current files to apply the container configuration."
              : "Restart the application to apply the changes."}
          </p>
        )}
        {data.guidance?.recommendations.length ? (
          <section
            aria-label="Suggestions for this website"
            className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card sm:p-6"
          >
            <h3 className="font-bold text-ink">Suggestions for this website</h3>
            <ul className="mt-4 space-y-4">
              {data.guidance.recommendations.map((item) => (
                <li key={item.id} className="rounded-xl bg-slate-50 p-4">
                  <h4 className="text-sm font-semibold text-slate-800">
                    {item.title}
                  </h4>
                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    {item.detail}
                  </p>
                  {item.section && (
                    <a
                      className="mt-2 inline-block text-sm font-semibold text-panel-700 underline underline-offset-2"
                      href={`${siteBase}/${item.section === "env" ? "settings#environment" : item.section}`}
                    >
                      Open{" "}
                      {item.section === "file-manager"
                        ? "Files"
                        : item.section === "env"
                          ? "Environment"
                          : item.section === "git"
                            ? "Git & Deploy"
                            : "Settings"}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      <div hidden={workflowStep !== 0} className="space-y-5">
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
                      <span className="font-bold text-ink">
                        {readiness.label}
                      </span>
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
      </div>
      <div hidden={workflowStep !== 1} className="space-y-5">
        <details
          open={data.preflight.checks.some((check) => check.status !== "ready")}
          className="rounded-2xl border border-white/60 bg-white/75 p-5 shadow-card backdrop-blur-md sm:p-6"
          aria-labelledby="preflight-title"
        >
          <summary className="cursor-pointer font-semibold">
            Deployment checks ·{" "}
            {
              data.preflight.checks.filter((check) => check.status === "ready")
                .length
            }{" "}
            passed
          </summary>
          <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 id="preflight-title" className="font-bold text-ink">
                Preflight checks
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                Server-verified requirements for this website and deployment
                path.
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
            {data.preflight.checks
              .filter((check) => showPassedChecks || check.status !== "ready")
              .map((check) => {
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
                        {check.fix && check.status !== "ready" && (
                          <div className="mt-3">
                            <Button
                              type="button"
                              size="sm"
                              disabled={busy || check.fix.status !== "ready"}
                              aria-busy={running === `fix:${check.fix.id}`}
                              title={check.fix.description}
                              onClick={(event) =>
                                requestFix(check.fix!, event.currentTarget)
                              }
                            >
                              {running === `fix:${check.fix.id}` ? (
                                <LoaderCircle
                                  className="h-4 w-4 animate-spin"
                                  aria-hidden="true"
                                />
                              ) : (
                                <Zap className="h-4 w-4" aria-hidden="true" />
                              )}
                              {check.fix.label}
                            </Button>
                            {check.fix.status !== "ready" &&
                              check.fix.blockedBy[0] && (
                                <p className="mt-1.5 text-xs text-slate-500">
                                  {check.fix.blockedBy[0]}
                                </p>
                              )}
                          </div>
                        )}
                        {check.id === "compose-config" &&
                          check.status === "blocked" &&
                          missingEnvVariables.length > 0 &&
                          data.permissions?.manage && (
                            <div className="mt-3">
                              <Button
                                type="button"
                                size="sm"
                                disabled={busy}
                                onClick={openEnvFix}
                              >
                                <FileCog
                                  className="h-4 w-4"
                                  aria-hidden="true"
                                />
                                Add missing values
                              </Button>
                            </div>
                          )}
                      </div>
                    </div>
                  </li>
                );
              })}
          </ul>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowPassedChecks((value) => !value)}
          >
            {showPassedChecks
              ? "Hide successful checks"
              : "Show successful checks"}
          </Button>
        </details>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => chooseWorkflowStep(0)}
          >
            Back to Review
          </Button>
          <Button
            disabled={busy || Boolean(deploymentBlocked)}
            onClick={() => chooseWorkflowStep(2)}
          >
            Continue to Deploy
          </Button>
        </div>
        {deploymentBlocked && (
          <p className="text-sm text-amber-800" role="status">
            {deploymentBlocked}
          </p>
        )}
      </div>
      </div>

      <div
        role="tabpanel"
        id="operations-panel-runtime"
        aria-labelledby="operations-tab-runtime"
        hidden={workspaceTab !== "runtime"}
        className="space-y-5"
      >
        {hasRuntime ? (
          <section
            className="rounded-2xl border border-white/60 bg-white/75 p-5 shadow-card backdrop-blur-md sm:p-6"
            aria-labelledby="runtime-title"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3
                  id="runtime-title"
                  className="flex items-center gap-2 font-bold text-ink"
                >
                  <Activity
                    className="h-4 w-4 text-panel-600"
                    aria-hidden="true"
                  />
                  Runtime
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  Live state auto-detected from this website&apos;s processes,
                  containers, and listening ports.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                aria-label="Refresh runtime state"
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
                Refresh
              </Button>
            </div>

            {data.compose?.rootless ? (
              <div className="mt-4 grid gap-3 rounded-xl border border-slate-200/80 bg-slate-50/70 p-4 sm:grid-cols-2 xl:grid-cols-4">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                    Docker engine
                  </p>
                  <p className="mt-1 text-sm font-semibold text-slate-700">
                    Rootless ·{" "}
                    {data.compose.rootless.ready ? "Ready" : "Needs setup"}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                    Owner
                  </p>
                  <p className="mt-1 truncate font-mono text-xs text-slate-700">
                    {data.compose.rootless.user ?? "site user"}
                    {data.compose.rootless.uid !== undefined
                      ? ` · UID ${data.compose.rootless.uid}`
                      : ""}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                    Storage
                  </p>
                  <p className="mt-1 text-sm font-semibold text-slate-700">
                    {data.compose.rootless.storageDriver || "Not available"}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-500">
                    Images {data.compose.rootless.imageUsage || "unknown"} ·{" "}
                    {data.compose.rootless.imageReclaimable || "unknown"}{" "}
                    reclaimable
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                    Home filesystem free
                  </p>
                  <p className="mt-1 text-sm font-semibold text-slate-700">
                    {typeof data.compose.rootless.availableBytes === "number"
                      ? formatBytes(data.compose.rootless.availableBytes)
                      : "Unknown"}
                  </p>
                </div>
                <p className="break-all font-mono text-[11px] text-slate-500 sm:col-span-2 xl:col-span-4">
                  Socket: {data.compose.rootless.socket || "not initialized"}
                  {data.compose.rootless.cgroupVersion
                    ? ` · cgroup v${data.compose.rootless.cgroupVersion}`
                    : ""}
                  {data.compose.rootless.networkHelperAvailable
                    ? " · userspace network ready"
                    : " · network helper missing"}
                </p>
              </div>
            ) : null}

            {data.migration?.legacyRootfulDetected ||
            data.migration?.recoveryRequired ? (
              <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 ring-1 ring-inset ring-amber-200">
                {data.migration.recoveryRequired
                  ? "An ownership recovery journal is active. Recover it before another cutover."
                  : `${data.migration.preparedServices?.length ?? 0} service(s) prepared for rootless migration${data.migration.expiresAt ? ` · expires ${data.migration.expiresAt}` : ""}.`}
              </div>
            ) : null}

            {runtime?.listeners?.length ? (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-400">
                  <Network className="h-3.5 w-3.5" aria-hidden="true" />{" "}
                  Listening
                </span>
                {runtime.listeners.map((listener) => (
                  <span
                    key={`${listener.address}:${listener.port}`}
                    className="rounded-full bg-slate-100 px-2.5 py-1 font-mono text-xs text-slate-600 ring-1 ring-inset ring-slate-200"
                    title={listener.address}
                  >
                    :{listener.port}
                    {listener.process ? ` · ${listener.process}` : ""}
                  </span>
                ))}
              </div>
            ) : null}

            {!canControlPm2 && data.pm2?.length ? (
              <p
                id="pm2-controls-unavailable"
                className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-inset ring-amber-200"
              >
                {!pm2Available
                  ? "PM2 controls are disabled because PM2 is unavailable."
                  : "PM2 controls require Operations management permission."}
              </p>
            ) : null}
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {(data.pm2 ?? []).map((process) => {
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
                    <p className="mt-2 text-center text-[11px] font-medium text-slate-400">
                      {online
                        ? `Up ${formatUptime(process.uptimeSeconds ?? 0)}`
                        : "Not running"}
                      {online && process.pid ? ` · PID ${process.pid}` : ""}
                    </p>
                    {data.permissions?.manage && (
                      <div className="mt-4 grid grid-cols-3 gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="px-2"
                          disabled={busy || !canControlPm2}
                          aria-label={`Restart ${process.name}`}
                          aria-busy={
                            running === `pm2-restart-one:${process.name}`
                          }
                          aria-describedby={
                            !canControlPm2
                              ? "pm2-controls-unavailable"
                              : undefined
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
                          <span className="sr-only sm:not-sr-only">
                            Restart
                          </span>
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
                            !canControlPm2
                              ? "pm2-controls-unavailable"
                              : undefined
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
                          aria-busy={
                            running === `pm2-delete-one:${process.name}`
                          }
                          aria-describedby={
                            !canControlPm2
                              ? "pm2-controls-unavailable"
                              : undefined
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
                    )}
                  </article>
                );
              })}
            </div>

            {runtime?.containers?.length ? (
              <div className="mt-5">
                <h4 className="flex items-center gap-2 text-sm font-bold text-ink">
                  <Container
                    className="h-4 w-4 text-panel-600"
                    aria-hidden="true"
                  />
                  Compose containers
                </h4>
                <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {runtime.containers.map((container) => {
                    const runningState = container.state === "running";
                    return (
                      <article
                        key={container.name || container.service}
                        className="rounded-xl border border-slate-200/80 bg-white/80 p-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h5 className="truncate font-bold text-ink">
                              {container.service || container.name}
                            </h5>
                            <p className="mt-0.5 truncate text-xs text-slate-400">
                              {container.name}
                            </p>
                          </div>
                          <span
                            className={cn(
                              "shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold capitalize",
                              runningState
                                ? "bg-emerald-50 text-emerald-700"
                                : "bg-red-50 text-red-700",
                            )}
                          >
                            {container.state}
                          </span>
                        </div>
                        <p className="mt-2 text-xs text-slate-500">
                          {container.status || container.state}
                          {container.health
                            ? ` · health: ${container.health}`
                            : ""}
                        </p>
                        {container.ports?.length ? (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {container.ports.map((port) => (
                              <code
                                key={port}
                                className="rounded bg-slate-950/[0.04] px-1.5 py-0.5 text-[11px] text-slate-600"
                              >
                                {port}
                              </code>
                            ))}
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {runtime?.envFile && runtime.env?.length ? (
              <div
                className={cn(
                  "mt-5 rounded-xl border p-4",
                  envDrift.length
                    ? "border-amber-200/80 bg-amber-50/50"
                    : "border-emerald-200/70 bg-emerald-50/40",
                )}
              >
                <h4 className="flex items-center gap-2 text-sm font-bold text-ink">
                  <FileCog
                    className={cn(
                      "h-4 w-4",
                      envDrift.length ? "text-amber-600" : "text-emerald-600",
                    )}
                    aria-hidden="true"
                  />
                  Environment ({runtime.envFile})
                </h4>
                <p className="mt-1 text-xs leading-5 text-slate-600">
                  {envDrift.length
                    ? `${envDrift.length} configured variable${envDrift.length === 1 ? "" : "s"} differ from the running process — restart it to apply the current ${runtime.envFile}.`
                    : `The running process environment matches the configured ${runtime.envFile}. Values are never shown here; edit them under Settings → Environment.`}
                </p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {runtime.env.map((item) => (
                    <span
                      key={item.key}
                      className={cn(
                        "rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold ring-1 ring-inset",
                        item.status === "match"
                          ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
                          : item.status === "unknown"
                            ? "bg-slate-100 text-slate-500 ring-slate-400/20"
                            : "bg-amber-50 text-amber-700 ring-amber-600/20",
                      )}
                      title={
                        item.status === "match"
                          ? "In sync with the running process"
                          : item.status === "differs"
                            ? "The running process has a different value"
                            : item.status === "missing"
                              ? "Not present in the running process"
                              : "No running process to compare against"
                      }
                    >
                      {item.key}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </section>
        ) : (
          <section className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center">
            <Activity
              className="mx-auto h-9 w-9 text-slate-300"
              aria-hidden="true"
            />
            <h3 className="mt-3 font-bold text-ink">No runtime detected</h3>
            <p className="mx-auto mt-1 max-w-2xl text-sm text-slate-500">
              No managed process, container, or listening application port was
              found for this website.
            </p>
          </section>
        )}
      </div>

      <div
        role="tabpanel"
        id="operations-panel-advanced"
        aria-labelledby="operations-tab-advanced"
        hidden={workspaceTab !== "advanced"}
        className="space-y-5"
      >
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card sm:p-6">
          <h3 className="font-bold text-ink">
            Individual commands and process controls
          </h3>
          <p className="mt-2 text-sm text-slate-500">
            Use these when the guided deployment does not cover your task. Each
            command retains its own permission and safety checks.
          </p>
          <div className="mt-4 space-y-4">
            {visibleGroups
              .filter(() => data.permissions?.manage)
              .map((group) => (
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
                    <p className="mt-1 text-sm text-slate-500">
                      {group.description}
                    </p>
                  </div>
                  <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {group.actions.map((action) => {
                    const key = actionKey(action);
                    const reasonId = `operation-${htmlId(group.id)}-${htmlId(key)}-reason`;
                    const Icon = ICONS[action.iconKey];
                    const runnable = isActionReady(action.status);
                    const actionBusy = running === key;
                    const showBlockedReason =
                      !runnable && blockingChecks.length === 0;
                    return (
                      <button
                        key={key}
                        type="button"
                        disabled={busy || !runnable}
                        aria-busy={actionBusy}
                        aria-describedby={
                          showBlockedReason ? reasonId : undefined
                        }
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
                          {showBlockedReason && (
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
              {blockingChecks.length ||
              data.preflight.status === "unauthorized" ? (
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
                    offered until the blocking preflight checks above are
                    resolved.
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
                    Panelavo found the website but did not detect a safe,
                    explicit operation it can run. Add a supported manifest or
                    process declaration, then refresh the preflight.
                  </p>
                </>
              )}
              </section>
            )}
          </div>
        </section>

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
      </div>

      {scheduledJobs && (
        <div
          role="tabpanel"
          id="operations-panel-jobs"
          aria-labelledby="operations-tab-jobs"
          hidden={workspaceTab !== "jobs"}
        >
          {openedWorkspaceTabs.has("jobs") ? scheduledJobs : null}
        </div>
      )}

      {logs && (
        <div
          role="tabpanel"
          id="operations-panel-logs"
          aria-labelledby="operations-tab-logs"
          hidden={workspaceTab !== "logs"}
        >
          {openedWorkspaceTabs.has("logs") ? logs : null}
        </div>
      )}

      {confirmation && (
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
      )}

      {envFixValues && (
        <div
          className="fixed inset-0 z-[100] grid place-items-center bg-slate-950/40 p-4"
          role="dialog"
          aria-modal="true"
          ref={envFixRef}
          aria-labelledby="compose-env-fix-title"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !savingEnvFix) setEnvFixValues(null);
          }}
        >
          <form
            className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-2xl bg-white p-6 shadow-2xl"
            onSubmit={saveEnvFix}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3
                  id="compose-env-fix-title"
                  className="text-lg font-bold text-ink"
                >
                  Add missing environment values
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  Panelavo will add only these keys to <code>.env</code>.
                  Existing settings and comments are preserved.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowEnvFixValues((current) => !current)}
              >
                {showEnvFixValues ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
                {showEnvFixValues ? "Hide" : "Show"}
              </Button>
            </div>
            <div className="mt-5 space-y-4">
              {Object.entries(envFixValues).map(([key, value], index) => (
                <label key={key} className="block">
                  <span className="mb-1.5 block text-sm font-semibold text-slate-700">
                    {key}
                  </span>
                  <Input
                    type={showEnvFixValues ? "text" : "password"}
                    value={value}
                    required
                    autoFocus={index === 0}
                    autoComplete="off"
                    placeholder={`Enter a value for ${key}`}
                    disabled={savingEnvFix}
                    onChange={(event) =>
                      setEnvFixValues((current) =>
                        current
                          ? { ...current, [key]: event.target.value }
                          : current,
                      )
                    }
                  />
                </label>
              ))}
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                disabled={savingEnvFix}
                onClick={() => setEnvFixValues(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  savingEnvFix ||
                  Object.values(envFixValues).some((value) => !value.trim())
                }
              >
                {savingEnvFix && (
                  <LoaderCircle
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                )}
                Save and recheck
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
