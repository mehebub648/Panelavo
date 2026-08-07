import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { cookies, headers } from "next/headers";
import type { CloudPanelSession, CloudPanelUser } from "@/types/cloudpanel";
import { getSecuritySettings } from "@/server/settings/store";

const COOKIE_NAME = "server_panel_session";
export interface SessionRecord {
  cloudPanel: CloudPanelSession;
  user?: CloudPanelUser;
  twoFactorPending?: boolean;
  expiresAt: number;
  createdAt?: number;
  lastSeenAt?: number;
  address?: string;
  userAgent?: string;
}

// Sessions live in a process-global map (survives Next.js module reloads) and
// are mirrored to disk so they survive process restarts (pm2 reload, deploy,
// reboot). Without this, every restart would sign every user out.
const globalSessions = globalThis as typeof globalThis & {
  __panelSessions?: Map<string, SessionRecord>;
  __panelSessionsLoaded?: boolean;
  __panelSessionsLastPersist?: number;
};
const sessions = (globalSessions.__panelSessions ??= new Map<
  string,
  SessionRecord
>());
const SESSION_FILE = join(process.cwd(), ".data", "sessions.json");
const DATA_DIR = join(process.cwd(), ".data");
const PERSIST_THROTTLE_MS = 10_000;

async function ensureLoaded() {
  if (globalSessions.__panelSessionsLoaded) return;
  globalSessions.__panelSessionsLoaded = true;
  try {
    const parsed = JSON.parse(await readFile(SESSION_FILE, "utf8")) as Record<
      string,
      SessionRecord
    >;
    const now = Date.now();
    for (const [key, value] of Object.entries(parsed)) {
      if (value?.expiresAt > now) sessions.set(key, value);
    }
  } catch {
    // No persisted sessions yet, or the file is unreadable — start empty.
  }
}

// Atomic write (temp file + rename) with restrictive permissions, since the
// file holds live authentication material.
async function saveSessions() {
  globalSessions.__panelSessionsLastPersist = Date.now();
  try {
    await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${SESSION_FILE}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(sessions)), {
      mode: 0o600,
    });
    await rename(tmp, SESSION_FILE);
  } catch {
    // Persistence is best-effort; the in-memory map remains authoritative.
  }
}

// updateSession runs on every authenticated request, so its writes are
// throttled to avoid per-request disk I/O; create/destroy persist immediately.
async function persistThrottled() {
  const now = Date.now();
  if (
    now - (globalSessions.__panelSessionsLastPersist ?? 0) <
    PERSIST_THROTTLE_MS
  )
    return;
  await saveSessions();
}

const developmentSecret = randomBytes(32).toString("hex");

async function maxAge() {
  return (await getSecuritySettings()).sessionLifetimeMinutes * 60;
}
function sessionSecret() {
  const value = process.env.SESSION_SECRET;
  if (value && value.length >= 32) return value;
  if (process.env.NODE_ENV === "production")
    throw new Error(
      "SESSION_SECRET must contain at least 32 characters in production.",
    );
  return value || developmentSecret;
}

export function appSecret() {
  return sessionSecret();
}

function sign(id: string) {
  return createHmac("sha256", sessionSecret()).update(id).digest("base64url");
}
function tokenFor(id: string) {
  return `${id}.${sign(id)}`;
}
function idFromToken(token?: string) {
  if (!token) return null;
  const [id, signature] = token.split(".");
  if (!id || !signature) return null;
  const expected = Buffer.from(sign(id));
  const received = Buffer.from(signature);
  return expected.length === received.length &&
    timingSafeEqual(expected, received)
    ? id
    : null;
}

function sweepExpiredSessions(now: number) {
  for (const [id, record] of sessions) {
    if (record.expiresAt < now) sessions.delete(id);
  }
}

// Production traffic reaches the loopback-only process through Nginx. Trust
// its forwarded scheme for the Secure flag; local development and an explicit
// SSH recovery tunnel remain usable without weakening the public TLS boundary.
async function isSecureRequest(): Promise<boolean> {
  try {
    const incoming = await headers();
    const proto = incoming.get("x-forwarded-proto");
    if (proto?.split(",")[0].trim() === "https") return true;
    const host = incoming.get("host")?.split(":")[0]?.toLowerCase();
    // A production-domain cookie must stay Secure even if a proxy is
    // misconfigured and omits the scheme header. Only an explicit loopback
    // SSH recovery session may use a non-Secure cookie.
    return (
      process.env.NODE_ENV === "production" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(host ?? "")
    );
  } catch {
    return process.env.NODE_ENV === "production";
  }
}

export async function createSession(record: Omit<SessionRecord, "expiresAt">) {
  await ensureLoaded();
  const now = Date.now();
  // Abandoned sessions (cookie expired, user never returns) are otherwise only
  // evicted on a same-id lookup, so the in-memory map grows without bound.
  sweepExpiredSessions(now);
  const id = randomBytes(32).toString("base64url");
  const incoming = await headers();
  const age = await maxAge();
  sessions.set(id, {
    ...record,
    createdAt: now,
    lastSeenAt: now,
    address: incoming.get("x-forwarded-for")?.split(",")[0]?.trim(),
    userAgent: incoming.get("user-agent")?.slice(0, 300),
    expiresAt: now + age * 1000,
  });
  const jar = await cookies();
  jar.set(COOKIE_NAME, tokenFor(id), {
    httpOnly: true,
    secure: await isSecureRequest(),
    sameSite: "strict",
    path: "/",
    maxAge: age,
  });
  await saveSessions();
  return id;
}

export async function getSession(options: { allowPending?: boolean } = {}) {
  await ensureLoaded();
  const id = idFromToken((await cookies()).get(COOKIE_NAME)?.value);
  if (!id) return null;
  const record = sessions.get(id);
  if (
    !record ||
    record.expiresAt < Date.now() ||
    (record.twoFactorPending && !options.allowPending)
  ) {
    sessions.delete(id);
    return null;
  }
  return { id, record };
}

export async function updateSession(id: string, patch: Partial<SessionRecord>) {
  await ensureLoaded();
  const current = sessions.get(id);
  if (current) {
    const age = await maxAge();
    sessions.set(id, {
      ...current,
      ...patch,
      lastSeenAt: Date.now(),
      expiresAt: Date.now() + age * 1000,
    });
    await persistThrottled();
  }
}

export type PublicSession = {
  id: string;
  current: boolean;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  address?: string;
  userAgent?: string;
};

export async function listUserSessions(username: string, currentId: string) {
  await ensureLoaded();
  sweepExpiredSessions(Date.now());
  return [...sessions.entries()]
    .filter(
      ([, record]) =>
        (
          record.user?.username || record.cloudPanel.usernameHint
        )?.toLowerCase() === username.toLowerCase(),
    )
    .map(([id, record]): PublicSession => ({
      id,
      current: id === currentId,
      createdAt: record.createdAt ?? record.lastSeenAt ?? Date.now(),
      lastSeenAt: record.lastSeenAt ?? record.createdAt ?? Date.now(),
      expiresAt: record.expiresAt,
      address: record.address,
      userAgent: record.userAgent,
    }))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export async function revokeUserSession(
  username: string,
  id: string,
  currentId: string,
) {
  await ensureLoaded();
  if (id === currentId)
    throw new Error("Use sign out to end the current session.");
  const record = sessions.get(id);
  const owner = record?.user?.username || record?.cloudPanel.usernameHint;
  if (record && owner?.toLowerCase() === username.toLowerCase())
    sessions.delete(id);
  await saveSessions();
}

export async function revokeOtherUserSessions(
  username: string,
  currentId: string,
) {
  await ensureLoaded();
  for (const [id, record] of sessions) {
    const owner = record.user?.username || record.cloudPanel.usernameHint;
    if (id !== currentId && owner?.toLowerCase() === username.toLowerCase())
      sessions.delete(id);
  }
  await saveSessions();
}

export async function destroySession() {
  await ensureLoaded();
  const jar = await cookies();
  const id = idFromToken(jar.get(COOKIE_NAME)?.value);
  if (id) sessions.delete(id);
  jar.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: await isSecureRequest(),
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  await saveSessions();
}

export function clearSessionStoreForTests() {
  sessions.clear();
  globalSessions.__panelSessionsLoaded = false;
  globalSessions.__panelSessionsLastPersist = 0;
}
