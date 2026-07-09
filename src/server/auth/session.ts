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

const COOKIE_NAME = "server_panel_session";
export interface SessionRecord {
  cloudPanel: CloudPanelSession;
  user?: CloudPanelUser;
  twoFactorPending?: boolean;
  expiresAt: number;
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

function maxAge() {
  return Number(process.env.SESSION_MAX_AGE_SECONDS ?? 3600);
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

// The Secure flag must track the actual request scheme, not NODE_ENV: over a
// plain http://ip:port connection a Secure cookie is silently dropped by the
// browser (which manifests as "session expired" on every login), while behind
// an HTTPS reverse proxy the request arrives as http with X-Forwarded-Proto.
async function isSecureRequest(): Promise<boolean> {
  try {
    const proto = (await headers()).get("x-forwarded-proto");
    return proto ? proto.split(",")[0].trim() === "https" : false;
  } catch {
    return false;
  }
}

export async function createSession(record: Omit<SessionRecord, "expiresAt">) {
  await ensureLoaded();
  const now = Date.now();
  // Abandoned sessions (cookie expired, user never returns) are otherwise only
  // evicted on a same-id lookup, so the in-memory map grows without bound.
  sweepExpiredSessions(now);
  const id = randomBytes(32).toString("base64url");
  sessions.set(id, { ...record, expiresAt: now + maxAge() * 1000 });
  const jar = await cookies();
  jar.set(COOKIE_NAME, tokenFor(id), {
    httpOnly: true,
    secure: await isSecureRequest(),
    sameSite: "lax",
    path: "/",
    maxAge: maxAge(),
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
    sessions.set(id, {
      ...current,
      ...patch,
      expiresAt: Date.now() + maxAge() * 1000,
    });
    await persistThrottled();
  }
}

export async function destroySession() {
  await ensureLoaded();
  const jar = await cookies();
  const id = idFromToken(jar.get(COOKIE_NAME)?.value);
  if (id) sessions.delete(id);
  jar.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: await isSecureRequest(),
    sameSite: "lax",
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
