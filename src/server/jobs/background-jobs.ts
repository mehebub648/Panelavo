import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PanelActor } from "@/server/auth/site-access";
import { AppError } from "@/server/cloudpanel/errors";
import {
  redactDeploymentOutput,
  type DeploymentProgress,
} from "@/lib/deployment";
import { jsonStore } from "@/server/storage/json-store";

const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OWNER_JOBS = 100;
const MAX_LOG_ENTRIES = 100;
const MAX_LOG_LENGTH = 2_000;
const MAX_RESULT_BYTES = 64 * 1024;

export type McpJobStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed-out"
  | "interrupted";

type McpJobLog = {
  at: string;
  message: string;
};

type McpJobRecord = {
  id: string;
  ownerUserId: string;
  credentialId: string;
  domain: string;
  kind: string;
  access?: "site";
  siteId?: string;
  idempotencyKey?: string;
  requestDigest?: string;
  progress?: DeploymentProgress[];
  actorName?: string;
  cancellable?: boolean;
  status: McpJobStatus;
  timeoutSeconds: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelRequestedAt?: string;
  error?: string;
  result?: unknown;
  logs: McpJobLog[];
};

type McpJobStore = { jobs: McpJobRecord[] };

export type McpJob = Omit<McpJobRecord, "ownerUserId" | "credentialId"> & {
  cancellable: boolean;
};

export type JobWork = (helpers: {
  signal: AbortSignal;
  progress: (event: DeploymentProgress) => Promise<void>;
  log: (message: string) => Promise<void>;
}) => Promise<unknown>;

const store = jsonStore<McpJobStore>(
  "mcp-jobs.json",
  () => ({ jobs: [] }),
  (value) => {
    if (!value || typeof value !== "object") return { jobs: [] };
    const jobs = (value as { jobs?: unknown }).jobs;
    return { jobs: Array.isArray(jobs) ? jobs : [] } as McpJobStore;
  },
  true,
);

const runtimes = new Map<string, AbortController>();
let mutationQueue: Promise<unknown> = Promise.resolve();
let initializedFor: string | undefined;

function dataDirectory() {
  return process.env.PANEL_DATA_DIR || join(process.cwd(), ".data");
}

function mutate<T>(work: () => Promise<T>): Promise<T> {
  const operation = mutationQueue.then(work, work);
  mutationQueue = operation.catch(() => undefined);
  return operation;
}

function actorCredential(actor: PanelActor) {
  if (actor.authentication !== "mcp" || !actor.credentialId)
    throw new AppError(
      "FORBIDDEN",
      "Background jobs require an authenticated MCP connection.",
      403,
    );
  return actor.credentialId;
}

function publicJob(job: McpJobRecord): McpJob {
  const value = {
    ...job,
    cancellable: job.cancellable !== false,
  } as Partial<McpJobRecord> & { cancellable: boolean };
  delete value.ownerUserId;
  delete value.credentialId;
  delete value.idempotencyKey;
  delete value.requestDigest;
  return value as McpJob;
}

function isActive(status: McpJobStatus) {
  return ["queued", "running", "cancelling"].includes(status);
}

function matchingJob(state: McpJobStore, actor: PanelActor, id: string) {
  const credentialId = actorCredential(actor);
  const job = state.jobs.find(
    (candidate) =>
      candidate.access !== "site" &&
      candidate.id === id &&
      candidate.ownerUserId === String(actor.user.id) &&
      candidate.credentialId === credentialId,
  );
  if (!job)
    throw new AppError("SITE_NOT_FOUND", "Background job not found.", 404);
  return job;
}

function trimState(state: McpJobStore) {
  const cutoff = Date.now() - JOB_TTL_MS;
  state.jobs = state.jobs.filter(
    (job) =>
      isActive(job.status) || new Date(job.updatedAt).getTime() >= cutoff,
  );
  const counts = new Map<string, number>();
  state.jobs = [...state.jobs]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .filter((job) => {
      const count = counts.get(job.ownerUserId) ?? 0;
      if (count >= MAX_OWNER_JOBS && !isActive(job.status)) return false;
      counts.set(job.ownerUserId, count + 1);
      return true;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function initialize() {
  const directory = dataDirectory();
  if (initializedFor === directory) return;
  await mutate(async () => {
    if (initializedFor === directory) return;
    const state = await store.load();
    const now = new Date().toISOString();
    let changed = false;
    for (const job of state.jobs) {
      if (!isActive(job.status)) continue;
      job.status = "interrupted";
      job.updatedAt = now;
      job.finishedAt = now;
      job.error = "The Panelavo process restarted before this job finished.";
      job.logs = [
        ...(Array.isArray(job.logs) ? job.logs : []),
        { at: now, message: job.error },
      ].slice(-MAX_LOG_ENTRIES);
      changed = true;
    }
    trimState(state);
    if (changed) await store.save(state);
    initializedFor = directory;
  });
}

async function appendLog(id: string, message: string) {
  await mutate(async () => {
    const state = await store.load();
    const job = state.jobs.find((candidate) => candidate.id === id);
    if (!job) return;
    const at = new Date().toISOString();
    job.updatedAt = at;
    job.logs = [
      ...(Array.isArray(job.logs) ? job.logs : []),
      {
        at,
        message: redactDeploymentOutput(message.trim()).slice(
          0,
          MAX_LOG_LENGTH,
        ),
      },
    ].slice(-MAX_LOG_ENTRIES);
    await store.save(state);
  });
}

export function boundedResult(value: unknown): unknown {
  function bounded(limit: number) {
    let nodes = 0;
    function visit(item: unknown, depth = 0): unknown {
      if (depth > 12 || ++nodes > 2_000) return { truncated: true };
      if (typeof item === "string") {
        const text = redactDeploymentOutput(item);
        if (text.length <= limit) return text;
        const half = Math.floor(limit / 2);
        return `${text.slice(0, half)}\n[Output truncated]\n${text.slice(-half)}`;
      }
      if (Array.isArray(item))
        return [
          ...item.slice(0, 60).map((entry) => visit(entry, depth + 1)),
          ...(item.length > 60 ? [{ truncated: true }] : []),
        ];
      if (item && typeof item === "object") {
        const entries = Object.entries(item);
        return Object.fromEntries([
          ...entries
            .slice(0, 60)
            .map(([key, entry]) => [
              key.slice(0, 200),
              visit(entry, depth + 1),
            ]),
          ...(entries.length > 60 ? [["truncated", true]] : []),
        ]);
      }
      return item;
    }
    return visit(value);
  }
  // Reduce all long fields together so earlier command output cannot consume
  // the space needed for the failed step and its final diagnostic lines.
  for (let limit = 8_000; limit >= 125; limit = Math.floor(limit / 2)) {
    const result = bounded(limit);
    if (Buffer.byteLength(JSON.stringify(result) ?? "null") <= MAX_RESULT_BYTES)
      return result;
  }
  return {
    truncated: true,
    message:
      "Result exceeded the storage limit. Review the saved step progress.",
  };
}

export function executionFailure(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const data = value as Record<string, unknown>;
  for (const key of ["run", "deployment"]) {
    const run = data[key];
    if (!run || typeof run !== "object" || Array.isArray(run)) continue;
    const result = run as {
      exitCode?: number;
      timedOut?: boolean;
      steps?: { exitCode?: number; timedOut?: boolean; label?: string }[];
    };
    const failed = result.steps?.find(
      (step) =>
        step.timedOut ||
        (typeof step.exitCode === "number" && step.exitCode !== 0),
    );
    if (result.timedOut || failed?.timedOut)
      return "The server operation timed out. Review its output before retrying.";
    if (
      failed ||
      (typeof result.exitCode === "number" && result.exitCode !== 0)
    )
      return failed?.label
        ? `${failed.label} failed. Review the step output before retrying.`
        : `The server operation exited with code ${result.exitCode}.`;
  }
}

async function appendProgress(id: string, event: DeploymentProgress) {
  await mutate(async () => {
    const state = await store.load();
    const job = state.jobs.find((candidate) => candidate.id === id);
    if (!job || !isActive(job.status)) return;
    const progress = boundedResult(event) as DeploymentProgress;
    const key = `${event.type}:${event.index ?? 0}`;
    job.progress = [
      ...(job.progress ?? []).filter(
        (item) => `${item.type}:${item.index ?? 0}` !== key,
      ),
      progress,
    ].slice(-32);
    job.updatedAt = new Date().toISOString();
    await store.save(state);
  });
}

async function finishJob(
  id: string,
  update: Pick<McpJobRecord, "status"> & {
    result?: unknown;
    error?: string;
    log: string;
  },
) {
  await mutate(async () => {
    const state = await store.load();
    const job = state.jobs.find((candidate) => candidate.id === id);
    if (!job) return;
    const now = new Date().toISOString();
    job.status = update.status;
    job.updatedAt = now;
    job.finishedAt = now;
    job.error = update.error;
    if (update.status !== "succeeded")
      job.progress = job.progress?.map((event) =>
        event.status === "running"
          ? { ...event, status: "failed", output: update.error || event.output }
          : event,
      );
    job.result = boundedResult(update.result);
    job.logs = [
      ...(Array.isArray(job.logs) ? job.logs : []),
      { at: now, message: update.log.slice(0, MAX_LOG_LENGTH) },
    ].slice(-MAX_LOG_ENTRIES);
    trimState(state);
    await store.save(state);
  });
}

async function executeJob(
  record: McpJobRecord,
  controller: AbortController,
  work: JobWork,
) {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, record.timeoutSeconds * 1000);
  try {
    await mutate(async () => {
      const state = await store.load();
      const job = state.jobs.find((candidate) => candidate.id === record.id);
      if (!job)
        throw new AppError("SITE_NOT_FOUND", "Background job not found.", 404);
      const now = new Date().toISOString();
      job.status = controller.signal.aborted ? "cancelling" : "running";
      job.startedAt = now;
      job.updatedAt = now;
      job.logs.push({ at: now, message: `Started ${job.kind}.` });
      await store.save(state);
    });
    if (controller.signal.aborted)
      throw new AppError(
        "REQUEST_CANCELLED",
        "The operation was cancelled.",
        409,
      );
    const value = await work({
      signal: controller.signal,
      log: (message) => appendLog(record.id, message),
      progress: (event) => appendProgress(record.id, event),
    });
    if (controller.signal.aborted)
      throw new AppError(
        "REQUEST_CANCELLED",
        "The operation was cancelled.",
        409,
      );
    const failure = executionFailure(value);
    if (failure) {
      await finishJob(record.id, {
        status: "failed",
        result: value,
        error: failure,
        log: `${record.kind} failed: ${failure}`,
      });
      return;
    }
    await finishJob(record.id, {
      status: "succeeded",
      result: value,
      log: `${record.kind} finished successfully.`,
    });
  } catch (error) {
    const cancelled = controller.signal.aborted;
    const message =
      error instanceof AppError
        ? error.message
        : "The background operation failed unexpectedly.";
    await finishJob(record.id, {
      status: timedOut ? "timed-out" : cancelled ? "cancelled" : "failed",
      error: timedOut ? "The job exceeded its configured timeout." : message,
      log: timedOut
        ? `${record.kind} timed out and its server process was stopped.`
        : cancelled
          ? `${record.kind} was cancelled and its server process was stopped.`
          : `${record.kind} failed: ${message}`,
    });
  } finally {
    clearTimeout(timer);
    runtimes.delete(record.id);
  }
}

export async function startBackgroundJob(
  actor: PanelActor,
  input: {
    domain: string;
    kind: string;
    timeoutSeconds: number;
    cancellable?: boolean;
    access?: "site";
    siteId?: string;
    idempotencyKey?: string;
    request?: unknown;
  },
  work: JobWork,
) {
  await initialize();
  const credentialId =
    input.access === "site"
      ? (actor.credentialId ?? "")
      : actorCredential(actor);
  const requestDigest = createHash("sha256")
    .update(JSON.stringify(input.request ?? {}))
    .digest("hex");
  let duplicate = false;
  const timeoutSeconds = Math.min(1_800, Math.max(30, input.timeoutSeconds));
  const record = await mutate(async () => {
    const state = await store.load();
    trimState(state);
    const domain = input.domain.toLowerCase();
    if (input.idempotencyKey) {
      const previous = state.jobs.find(
        (job) =>
          job.access === "site" &&
          job.siteId === input.siteId &&
          job.ownerUserId === String(actor.user.id) &&
          job.idempotencyKey === input.idempotencyKey,
      );
      if (previous) {
        if (previous.requestDigest !== requestDigest)
          throw new AppError(
            "INVALID_REQUEST",
            "This idempotency key was already used for a different deployment.",
            409,
          );
        duplicate = true;
        return previous;
      }
    }
    const collision = state.jobs.find(
      (job) => job.domain === domain && isActive(job.status),
    );
    if (collision)
      throw new AppError(
        "OPERATION_BUSY",
        "A background job is already running for this website.",
        409,
      );
    const now = new Date().toISOString();
    const job: McpJobRecord = {
      id: randomUUID(),
      ownerUserId: String(actor.user.id),
      credentialId,
      access: input.access,
      siteId: input.siteId,
      idempotencyKey: input.idempotencyKey,
      requestDigest,
      actorName: actor.user.username,
      domain,
      kind: input.kind.slice(0, 100),
      cancellable: input.cancellable !== false,
      status: "queued",
      timeoutSeconds,
      createdAt: now,
      updatedAt: now,
      logs: [{ at: now, message: `${input.kind} queued.` }],
    };
    state.jobs.push(job);
    await store.save(state);
    return job;
  });
  if (duplicate) return publicJob(record);
  const controller = new AbortController();
  runtimes.set(record.id, controller);
  queueMicrotask(() => void executeJob(record, controller, work));
  return publicJob(record);
}

export async function getMcpJob(actor: PanelActor, id: string) {
  await initialize();
  return mutate(async () => {
    const state = await store.load();
    trimState(state);
    const job = matchingJob(state, actor, id);
    await store.save(state);
    return publicJob(job);
  });
}

export async function listMcpJobs(actor: PanelActor, domain?: string) {
  await initialize();
  const credentialId = actorCredential(actor);
  return mutate(async () => {
    const state = await store.load();
    trimState(state);
    const normalized = domain?.toLowerCase();
    const jobs = state.jobs
      .filter(
        (job) =>
          job.access !== "site" &&
          job.ownerUserId === String(actor.user.id) &&
          job.credentialId === credentialId &&
          (!normalized || job.domain === normalized),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50)
      .map(publicJob);
    await store.save(state);
    return { jobs };
  });
}

export async function cancelMcpJob(actor: PanelActor, id: string) {
  await initialize();
  const job = await mutate(async () => {
    const state = await store.load();
    const current = matchingJob(state, actor, id);
    if (!isActive(current.status)) return publicJob(current);
    if (current.cancellable === false)
      throw new AppError(
        "INVALID_REQUEST",
        "This consistency-critical job cannot be cancelled after it starts.",
        409,
      );
    const now = new Date().toISOString();
    current.status = "cancelling";
    current.cancelRequestedAt = now;
    current.updatedAt = now;
    current.logs = [
      ...current.logs,
      { at: now, message: "Cancellation requested." },
    ].slice(-MAX_LOG_ENTRIES);
    await store.save(state);
    return publicJob(current);
  });
  runtimes.get(id)?.abort();
  return job;
}

// Callers must check current site-write access before using site-shared results.
export async function listSiteJobs(siteId: string, domain: string) {
  await initialize();
  return mutate(async () => {
    const state = await store.load();
    trimState(state);
    return state.jobs
      .filter(
        (job) =>
          job.access === "site" &&
          job.siteId === siteId &&
          job.domain === domain.toLowerCase(),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50)
      .map(publicJob);
  });
}
