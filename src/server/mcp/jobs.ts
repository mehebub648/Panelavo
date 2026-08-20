import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PanelActor } from "@/server/auth/site-access";
import { AppError } from "@/server/cloudpanel/errors";
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

export type McpJob = Omit<McpJobRecord, "ownerUserId" | "credentialId">;

type JobWork = (helpers: {
  signal: AbortSignal;
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
  const value = { ...job } as Partial<McpJobRecord>;
  delete value.ownerUserId;
  delete value.credentialId;
  return value as McpJob;
}

function isActive(status: McpJobStatus) {
  return ["queued", "running", "cancelling"].includes(status);
}

function matchingJob(state: McpJobStore, actor: PanelActor, id: string) {
  const credentialId = actorCredential(actor);
  const job = state.jobs.find(
    (candidate) =>
      candidate.id === id &&
      candidate.ownerUserId === String(actor.user.id) &&
      candidate.credentialId === credentialId,
  );
  if (!job) throw new AppError("SITE_NOT_FOUND", "Background job not found.", 404);
  return job;
}

function trimState(state: McpJobStore) {
  const cutoff = Date.now() - JOB_TTL_MS;
  state.jobs = state.jobs.filter(
    (job) => isActive(job.status) || new Date(job.updatedAt).getTime() >= cutoff,
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
      { at, message: message.trim().slice(0, MAX_LOG_LENGTH) },
    ].slice(-MAX_LOG_ENTRIES);
    await store.save(state);
  });
}

function boundedResult(value: unknown) {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    return Buffer.byteLength(serialized) <= MAX_RESULT_BYTES
      ? value
      : { truncated: true, bytes: Buffer.byteLength(serialized) };
  } catch {
    return { unavailable: true };
  }
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
    job.result = boundedResult(update.result);
    job.logs = [
      ...(Array.isArray(job.logs) ? job.logs : []),
      { at: now, message: update.log.slice(0, MAX_LOG_LENGTH) },
    ].slice(-MAX_LOG_ENTRIES);
    trimState(state);
    await store.save(state);
  });
}

async function executeJob(record: McpJobRecord, controller: AbortController, work: JobWork) {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, record.timeoutSeconds * 1000);
  try {
    await mutate(async () => {
      const state = await store.load();
      const job = state.jobs.find((candidate) => candidate.id === record.id);
      if (!job) throw new AppError("SITE_NOT_FOUND", "Background job not found.", 404);
      const now = new Date().toISOString();
      job.status = controller.signal.aborted ? "cancelling" : "running";
      job.startedAt = now;
      job.updatedAt = now;
      job.logs.push({ at: now, message: `Started ${job.kind}.` });
      await store.save(state);
    });
    if (controller.signal.aborted)
      throw new AppError("REQUEST_CANCELLED", "The operation was cancelled.", 409);
    const value = await work({
      signal: controller.signal,
      log: (message) => appendLog(record.id, message),
    });
    if (controller.signal.aborted)
      throw new AppError("REQUEST_CANCELLED", "The operation was cancelled.", 409);
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

export async function startMcpJob(
  actor: PanelActor,
  input: {
    domain: string;
    kind: string;
    timeoutSeconds: number;
  },
  work: JobWork,
) {
  await initialize();
  const credentialId = actorCredential(actor);
  const timeoutSeconds = Math.min(1_800, Math.max(30, input.timeoutSeconds));
  const record = await mutate(async () => {
    const state = await store.load();
    trimState(state);
    const domain = input.domain.toLowerCase();
    const collision = state.jobs.find(
      (job) =>
        job.domain === domain && isActive(job.status),
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
      domain,
      kind: input.kind.slice(0, 100),
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
