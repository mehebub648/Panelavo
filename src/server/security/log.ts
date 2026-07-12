import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { CloudPanelUser } from "@/types/cloudpanel";

const AUDIT_VERSION = 1 as const;
const ZERO_HASH = "0".repeat(64);
const CURRENT_FILE = "audit.jsonl";
const HEAD_FILE = "head.json";
const LOCK_DIRECTORY = ".write-lock";
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 12;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const MAX_CONTEXT_DEPTH = 7;
const MAX_CONTEXT_KEYS = 100;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 2_048;

export type AuditResult = "success" | "failure";

export type AuditActor = {
  id?: string;
  username?: string;
  role?: string;
};

export type AuditTarget = {
  type: string;
  id?: string;
  [key: string]: unknown;
};

export type AuditContext = {
  actor?: AuditActor;
  target?: AuditTarget;
  request?: {
    id?: string;
    method?: string;
    path?: string;
  };
  client?: {
    address?: string;
    userAgent?: string;
  };
  details?: Record<string, unknown>;
};

export type AuditEvent = AuditContext & {
  version: typeof AUDIT_VERSION;
  id: string;
  timestamp: string;
  action: string;
  result: AuditResult;
  previousHash: string;
  hash: string;
};

export type AuditIntegrity = {
  valid: boolean;
  checkedEvents: number;
  headHash?: string;
  issues: string[];
};

export type AuditPage = {
  events: AuditEvent[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  integrity: AuditIntegrity;
};

export type AuditQuery = {
  page?: number;
  pageSize?: number;
  action?: string;
  result?: AuditResult;
  actor?: string;
  target?: string;
  search?: string;
  from?: string;
  to?: string;
};

type UnsignedAuditEvent = Omit<AuditEvent, "hash">;
type AuditHead = {
  version: typeof AUDIT_VERSION;
  lastHash: string;
  lastEventId: string;
  updatedAt: string;
};

type AuditContextOptions = {
  request?: Request;
  requestId?: string;
  actor?:
    | CloudPanelUser
    | AuditActor
    | { id?: string; username?: string; panelRole?: string; role?: string }
    | string
    | null;
  target?: AuditTarget;
  details?: Record<string, unknown>;
  error?: unknown;
};

const sensitiveExactKeys = new Set([
  "authorization",
  "code",
  "cookie",
  "cookies",
  "csrf",
  "csrftoken",
  "encryptionkey",
  "mfacode",
  "otp",
  "password",
  "passphrase",
  "refreshtoken",
  "secret",
  "sessionid",
  "token",
  "totp",
]);

const sensitiveKeyFragments = [
  "accesstoken",
  "apikey",
  "apisecret",
  "authorization",
  "clientsecret",
  "encryptionkey",
  "password",
  "passphrase",
  "privatekey",
  "refreshtoken",
  "sessiontoken",
];

function normalizedKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string) {
  const normalized = normalizedKey(key);
  return (
    sensitiveExactKeys.has(normalized) ||
    sensitiveKeyFragments.some((fragment) => normalized.includes(fragment)) ||
    normalized.endsWith("passwd") ||
    normalized.endsWith("cookie") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret")
  );
}

function redactInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error)
    return { name: value.name || "Error" };
  if (Array.isArray(value)) return value.map((item) => redactInternal(item, seen));
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    const redacted = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSensitiveKey(key) ? "[REDACTED]" : redactInternal(item, seen),
      ]),
    );
    seen.delete(value);
    return redacted;
  }
  return value;
}

/** Recursively removes values whose keys identify authentication or secret material. */
export function redact(value: unknown): unknown {
  return redactInternal(value, new WeakSet());
}

function boundedValue(value: unknown, depth = 0): unknown {
  if (depth >= MAX_CONTEXT_DEPTH) return "[MAX_DEPTH]";
  if (typeof value === "string")
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}...[TRUNCATED]`
      : value;
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => boundedValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push("[TRUNCATED]");
    return items;
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_CONTEXT_KEYS)
        .map(([key, item]) => [key, boundedValue(item, depth + 1)]),
    );
  if (value === undefined) return undefined;
  return String(value);
}

function sanitizeContext(context: AuditContext): AuditContext {
  return (boundedValue(redact(context)) ?? {}) as AuditContext;
}

function errorDetails(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
  };
  return {
    errorName:
      typeof value.name === "string" && value.name ? value.name : "Error",
    ...(typeof value.code === "string" ? { errorCode: value.code } : {}),
    ...(typeof value.status === "number" ? { errorStatus: value.status } : {}),
  };
}

function actorFrom(
  actor: AuditContextOptions["actor"],
): AuditActor | undefined {
  if (!actor) return undefined;
  if (typeof actor === "string") return { username: actor };
  const value = actor as {
    id?: unknown;
    username?: unknown;
    panelRole?: unknown;
    role?: unknown;
  };
  const result: AuditActor = {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.username === "string"
      ? { username: value.username }
      : {}),
    ...(typeof value.panelRole === "string"
      ? { role: value.panelRole }
      : typeof value.role === "string"
        ? { role: value.role }
        : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

/** Builds consistent request, actor, target, client, and safe failure metadata. */
export function auditContext(options: AuditContextOptions): AuditContext {
  const requestId =
    options.requestId || options.request?.headers.get("x-request-id") || undefined;
  let path: string | undefined;
  if (options.request) {
    try {
      path = new URL(options.request.url).pathname;
    } catch {
      path = undefined;
    }
  }
  const address =
    options.request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    options.request?.headers.get("x-real-ip")?.trim() ||
    undefined;
  const userAgent = options.request?.headers.get("user-agent") || undefined;
  const failure = errorDetails(options.error);
  return sanitizeContext({
    ...(actorFrom(options.actor) ? { actor: actorFrom(options.actor) } : {}),
    ...(options.target ? { target: options.target } : {}),
    ...(options.request
      ? {
          request: {
            ...(requestId ? { id: requestId } : {}),
            method: options.request.method,
            ...(path ? { path } : {}),
          },
        }
      : {}),
    ...(address || userAgent
      ? {
          client: {
            ...(address ? { address } : {}),
            ...(userAgent ? { userAgent } : {}),
          },
        }
      : {}),
    ...(options.details || failure
      ? { details: { ...(options.details ?? {}), ...(failure ?? {}) } }
      : {}),
  });
}

function dataDirectory() {
  return process.env.PANEL_DATA_DIR || join(process.cwd(), ".data");
}

function auditDirectory() {
  return join(dataDirectory(), "audit");
}

function currentPath() {
  return join(auditDirectory(), CURRENT_FILE);
}

function rotationPath(index: number) {
  return join(auditDirectory(), `audit.${index}.jsonl`);
}

function headPath() {
  return join(auditDirectory(), HEAD_FILE);
}

function lockPath() {
  return join(auditDirectory(), LOCK_DIRECTORY);
}

function positiveInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function maxBytes() {
  return positiveInteger(
    "PANEL_AUDIT_MAX_BYTES",
    DEFAULT_MAX_BYTES,
    512,
    100 * 1024 * 1024,
  );
}

function maxFiles() {
  return positiveInteger("PANEL_AUDIT_MAX_FILES", DEFAULT_MAX_FILES, 2, 100);
}

function lockTimeout() {
  return positiveInteger(
    "PANEL_AUDIT_LOCK_TIMEOUT_MS",
    DEFAULT_LOCK_TIMEOUT_MS,
    100,
    60_000,
  );
}

async function ensureAuditDirectory() {
  await mkdir(auditDirectory(), { recursive: true, mode: 0o700 });
  await chmod(auditDirectory(), 0o700).catch(() => undefined);
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireFileLock() {
  await ensureAuditDirectory();
  const started = Date.now();
  let wait = 15;
  while (true) {
    try {
      await mkdir(lockPath(), { mode: 0o700 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const lock = await stat(lockPath());
        if (Date.now() - lock.mtimeMs > STALE_LOCK_MS) {
          await rm(lockPath(), { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() - started >= lockTimeout())
        throw new Error("Timed out waiting for the audit ledger lock.");
      await delay(wait);
      wait = Math.min(200, Math.ceil(wait * 1.5));
    }
  }
}

async function withFileLock<T>(work: () => Promise<T>): Promise<T> {
  await acquireFileLock();
  try {
    return await work();
  } finally {
    await rm(lockPath(), { recursive: true, force: true }).catch(() => undefined);
  }
}

let auditQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = auditQueue.then(work, work);
  auditQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function hashEvent(event: UnsignedAuditEvent) {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isAuditEvent(value: unknown): value is AuditEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<AuditEvent>;
  return (
    event.version === AUDIT_VERSION &&
    typeof event.id === "string" &&
    typeof event.timestamp === "string" &&
    typeof event.action === "string" &&
    (event.result === "success" || event.result === "failure") &&
    isHash(event.previousHash) &&
    isHash(event.hash)
  );
}

async function readHead(): Promise<AuditHead | null> {
  try {
    const parsed = JSON.parse(await readFile(headPath(), "utf8")) as AuditHead;
    return parsed.version === AUDIT_VERSION && isHash(parsed.lastHash)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function writeHead(event: AuditEvent) {
  const value: AuditHead = {
    version: AUDIT_VERSION,
    lastHash: event.hash,
    lastEventId: event.id,
    updatedAt: new Date().toISOString(),
  };
  const temporary = `${headPath()}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => undefined);
  await rename(temporary, headPath());
}

async function ledgerFilesOldestFirst() {
  await ensureAuditDirectory();
  const names = await readdir(auditDirectory()).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    },
  );
  const rotations = names
    .map((name) => ({ name, match: /^audit\.(\d+)\.jsonl$/.exec(name) }))
    .filter(
      (item): item is { name: string; match: RegExpExecArray } =>
        Boolean(item.match),
    )
    .sort((left, right) => Number(right.match[1]) - Number(left.match[1]))
    .map((item) => join(auditDirectory(), item.name));
  if (names.includes(CURRENT_FILE)) rotations.push(currentPath());
  return rotations;
}

async function lastStoredEvent(): Promise<AuditEvent | null> {
  const files = await ledgerFilesOldestFirst();
  for (const file of [...files].reverse()) {
    const lines = (await readFile(file, "utf8"))
      .split("\n")
      .filter((line) => line.trim());
    for (const line of lines.reverse()) {
      try {
        const event = JSON.parse(line) as unknown;
        if (isAuditEvent(event)) return event;
      } catch {
        // Integrity inspection reports malformed records; appending continues.
      }
    }
  }
  return null;
}

async function rotateIfNeeded(lineBytes: number) {
  let size = 0;
  try {
    size = (await stat(currentPath())).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!size || size + lineBytes <= maxBytes()) return;
  const retainedRotations = maxFiles() - 1;
  await rm(rotationPath(retainedRotations), { force: true });
  for (let index = retainedRotations - 1; index >= 1; index -= 1) {
    await rename(rotationPath(index), rotationPath(index + 1)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
  }
  await rename(currentPath(), rotationPath(1));
}

async function appendEvent(
  base: Omit<UnsignedAuditEvent, "previousHash">,
): Promise<AuditEvent> {
  return withFileLock(async () => {
    const [head, last] = await Promise.all([readHead(), lastStoredEvent()]);
    if (head && last && head.lastHash !== last.hash)
      console.error(
        "Audit ledger head mismatch detected before append; the ledger remains available for integrity review.",
      );
    const previousHash = last?.hash || head?.lastHash || ZERO_HASH;
    const unsigned: UnsignedAuditEvent = { ...base, previousHash };
    const event: AuditEvent = { ...unsigned, hash: hashEvent(unsigned) };
    const line = `${JSON.stringify(event)}\n`;
    await rotateIfNeeded(Buffer.byteLength(line));
    const handle = await open(currentPath(), "a", 0o600);
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(currentPath(), 0o600).catch(() => undefined);
    await writeHead(event);
    return event;
  });
}

function normalizedContext(context: AuditContext | Record<string, unknown>) {
  const value = sanitizeContext(context as AuditContext) as AuditContext &
    Record<string, unknown>;
  const { actor, target, request, client, details, ...legacy } = value;
  return {
    ...(actor ? { actor } : {}),
    ...(target ? { target } : {}),
    ...(request ? { request } : {}),
    ...(client ? { client } : {}),
    ...(details || Object.keys(legacy).length
      ? { details: { ...(details ?? {}), ...legacy } }
      : {}),
  } satisfies AuditContext;
}

/**
 * Emits one JSON event to stdout and durably appends the same event to the
 * bounded, hash-chained ledger. Logging failures never mask the product action
 * that was already attempted; they are reported separately on stderr/stdout.
 */
export async function audit(
  action: string,
  result: AuditResult,
  context: AuditContext | Record<string, unknown> = {},
) {
  const base = {
    version: AUDIT_VERSION,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    action: String(action).slice(0, 200),
    result,
    ...normalizedContext(context),
  } satisfies Omit<UnsignedAuditEvent, "previousHash">;
  await serialized(async () => {
    try {
      const event = await appendEvent(base);
      console.info(JSON.stringify(event));
    } catch (error) {
      console.error("Audit ledger persistence failed:",
        error instanceof Error ? error.message : "unknown error");
      console.info(
        JSON.stringify({
          ...base,
          persistence: "failed",
        }),
      );
    }
  });
}

function eventWithoutHash(event: AuditEvent): UnsignedAuditEvent {
  const { hash, ...unsigned } = event;
  void hash;
  return unsigned;
}

async function inspectLedger(): Promise<{
  events: AuditEvent[];
  integrity: AuditIntegrity;
}> {
  const events: AuditEvent[] = [];
  const issues: string[] = [];
  const files = await ledgerFilesOldestFirst();
  let previous: AuditEvent | undefined;
  for (const file of files) {
    const lines = (await readFile(file, "utf8")).split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        issues.push(`${file}:${index + 1} contains invalid JSON.`);
        continue;
      }
      if (!isAuditEvent(parsed)) {
        issues.push(`${file}:${index + 1} has an invalid audit schema.`);
        continue;
      }
      const expectedHash = hashEvent(eventWithoutHash(parsed));
      if (expectedHash !== parsed.hash)
        issues.push(`${file}:${index + 1} failed its content hash check.`);
      if (previous && parsed.previousHash !== previous.hash)
        issues.push(`${file}:${index + 1} does not link to the prior event.`);
      events.push(parsed);
      previous = parsed;
    }
  }
  const head = await readHead();
  if (events.length && (!head || head.lastHash !== events.at(-1)?.hash))
    issues.push("The persisted audit head does not match the newest event.");
  if (!events.length && head)
    issues.push("The persisted audit head exists without retained events.");
  return {
    events,
    integrity: {
      valid: issues.length === 0,
      checkedEvents: events.length,
      ...(head?.lastHash ? { headHash: head.lastHash } : {}),
      issues: issues.slice(0, 25),
    },
  };
}

function contains(value: unknown, query?: string) {
  if (!query) return true;
  return JSON.stringify(value).toLowerCase().includes(query.toLowerCase());
}

function time(value?: string) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Reads retained events newest-first with filtering, pagination, and verification. */
export async function readAuditEvents(query: AuditQuery = {}): Promise<AuditPage> {
  return serialized(() =>
    withFileLock(async () => {
      const { events, integrity } = await inspectLedger();
      const action = query.action?.trim().toLowerCase();
      const actor = query.actor?.trim();
      const target = query.target?.trim();
      const search = query.search?.trim().toLowerCase();
      const from = time(query.from);
      const to = time(query.to);
      const filtered = events
        .filter((event) => !action || event.action.toLowerCase().includes(action))
        .filter((event) => !query.result || event.result === query.result)
        .filter((event) => contains(event.actor, actor))
        .filter((event) => contains(event.target, target))
        .filter((event) => {
          const timestamp = Date.parse(event.timestamp);
          return (from === undefined || timestamp >= from) &&
            (to === undefined || timestamp <= to);
        })
        .filter(
          (event) =>
            !search ||
            JSON.stringify({
              action: event.action,
              actor: event.actor,
              target: event.target,
              details: event.details,
            })
              .toLowerCase()
              .includes(search),
        )
        .reverse();
      const pageSize = Math.min(100, Math.max(1, Math.trunc(query.pageSize ?? 25)));
      const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
      const page = Math.min(
        totalPages,
        Math.max(1, Math.trunc(query.page ?? 1)),
      );
      const offset = (page - 1) * pageSize;
      return {
        events: filtered.slice(offset, offset + pageSize),
        pagination: {
          page,
          pageSize,
          total: filtered.length,
          totalPages,
        },
        integrity,
      };
    }),
  );
}

export function resetAuditQueueForTests() {
  auditQueue = Promise.resolve();
}
