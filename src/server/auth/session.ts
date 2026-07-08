import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import type { CloudPanelSession, CloudPanelUser } from "@/types/cloudpanel";

const COOKIE_NAME = "server_panel_session";
export interface SessionRecord {
  cloudPanel: CloudPanelSession;
  user?: CloudPanelUser;
  twoFactorPending?: boolean;
  expiresAt: number;
}

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const globalSessions = globalThis as typeof globalThis & {
  __panelSessions?: Map<string, SessionRecord>;
};
const sessions = (globalSessions.__panelSessions ??= new Map<
  string,
  SessionRecord
>());
const SESSION_FILE = join(process.cwd(), ".data", "sessions.json");

async function loadSessions(): Promise<Map<string, SessionRecord>> {
  if (sessions.size > 0) return sessions;
  try {
    const data = await readFile(SESSION_FILE, "utf8");
    const parsed = JSON.parse(data);
    for (const [key, value] of Object.entries(parsed)) {
      sessions.set(key, value as SessionRecord);
    }
  } catch {}
  return sessions;
}

async function saveSessions() {
  await mkdir(join(process.cwd(), ".data"), { recursive: true });
  await writeFile(SESSION_FILE, JSON.stringify(Object.fromEntries(sessions)), "utf8");
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

export async function createSession(record: Omit<SessionRecord, "expiresAt">) {
  const now = Date.now();
  // Abandoned sessions (cookie expired, user never returns) are otherwise only
  // evicted on a same-id lookup, so the in-memory map grows without bound.
  sweepExpiredSessions(now);
  const id = randomBytes(32).toString("base64url");
  sessions.set(id, { ...record, expiresAt: now + maxAge() * 1000 });
  const jar = await cookies();
  jar.set(COOKIE_NAME, tokenFor(id), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: maxAge(),
  });
  return id;
}

export async function getSession(options: { allowPending?: boolean } = {}) {
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
  const current = sessions.get(id);
  if (current)
    sessions.set(id, {
      ...current,
      ...patch,
      expiresAt: Date.now() + maxAge() * 1000,
    });
}

export async function destroySession() {
  const jar = await cookies();
  const id = idFromToken(jar.get(COOKIE_NAME)?.value);
  if (id) sessions.delete(id);
  jar.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
}

export function clearSessionStoreForTests() {
  sessions.clear();
}
