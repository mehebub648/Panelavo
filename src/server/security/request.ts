import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { AppError } from "@/server/cloudpanel/errors";

function isLoopbackHost(host: string | null) {
  const name = host?.split(":")[0]?.toLowerCase();
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}

export function assertSecureAuthenticationRequest(request: NextRequest) {
  if (process.env.NODE_ENV !== "production") return;
  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  if (forwardedProto === "https" || isLoopbackHost(request.headers.get("host")))
    return;
  throw new AppError(
    "FORBIDDEN",
    "Sign-in is available only over HTTPS.",
    403,
  );
}

export function assertWriteRequest(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new AppError("INVALID_REQUEST", "Requests must use JSON.", 415);
  }
  const site = request.headers.get("sec-fetch-site");
  if (site && !["same-origin", "none"].includes(site))
    throw new AppError(
      "FORBIDDEN",
      "Cross-origin requests are not allowed.",
      403,
    );
  // Compare Origin with the real HTTP Host. Nginx preserves this value, while
  // X-Forwarded-Host is deliberately ignored so a direct or misconfigured
  // upstream cannot choose both sides of the CSRF comparison.
  const origin = request.headers.get("origin");
  if (origin) {
    const host = request.headers.get("host")?.trim();
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new AppError("FORBIDDEN", "Cross-origin requests are not allowed.", 403);
    }
    if (host && originHost !== host)
      throw new AppError(
        "FORBIDDEN",
        "Cross-origin requests are not allowed.",
        403,
      );
  }
}

type Entry = { count: number; reset: number };
const globalRateStore = globalThis as typeof globalThis & {
  __panelRateLimits?: Map<string, Entry>;
  __panelRateSweep?: number;
  __panelRateLimitsLoaded?: boolean;
};
const store = (globalRateStore.__panelRateLimits ??= new Map());
const rateDataDir = () =>
  process.env.PANEL_DATA_DIR || join(process.cwd(), ".data");
const rateFile = () => join(rateDataDir(), "rate-limits.json");

function ensureRateStoreLoaded(now: number) {
  if (globalRateStore.__panelRateLimitsLoaded) return;
  globalRateStore.__panelRateLimitsLoaded = true;
  try {
    const parsed = JSON.parse(readFileSync(rateFile(), "utf8")) as Record<
      string,
      Entry
    >;
    for (const [key, entry] of Object.entries(parsed)) {
      if (
        key.length <= 256 &&
        Number.isInteger(entry?.count) &&
        entry.count > 0 &&
        Number.isFinite(entry.reset) &&
        entry.reset > now
      ) {
        store.set(key, entry);
      }
    }
  } catch {
    // Missing or invalid state starts empty. A successful mutation rewrites a
    // validated store, so a malformed file cannot disable request handling.
  }
}

function persistRateStore() {
  try {
    mkdirSync(rateDataDir(), { recursive: true, mode: 0o700 });
    const temporary = `${rateFile()}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(store)), {
      mode: 0o600,
    });
    renameSync(temporary, rateFile());
  } catch (error) {
    console.error("Panelavo could not persist request throttling state.", error);
  }
}

// Keys are derived from attacker-controlled input (e.g. the X-Forwarded-For
// header on unauthenticated login attempts), so the map must evict expired
// entries — otherwise a flood of unique keys grows it without bound (OOM).
function sweep(now: number) {
  if (now - (globalRateStore.__panelRateSweep ?? 0) < 60_000) return;
  globalRateStore.__panelRateSweep = now;
  for (const [key, entry] of store) {
    if (entry.reset < now) store.delete(key);
  }
}

export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  ensureRateStoreLoaded(now);
  sweep(now);
  const entry = store.get(key);
  if (!entry || entry.reset < now) {
    store.set(key, { count: 1, reset: now + windowMs });
    persistRateStore();
    return;
  }
  if (entry.count >= limit)
    throw new AppError(
      "INVALID_REQUEST",
      "Too many attempts. Please wait and try again.",
      429,
    );
  entry.count += 1;
  persistRateStore();
}

export function clientKey(request: NextRequest) {
  // The production listener is loopback-only and receives this header from
  // Nginx. Prefer X-Real-IP because the proxy overwrites it instead of
  // extending an attacker-provided forwarding chain.
  const address = request.headers.get("x-real-ip")?.trim() ?? "";
  return isIP(address) ? address : "local";
}

export function clearRateLimitStoreForTests() {
  store.clear();
  globalRateStore.__panelRateLimitsLoaded = false;
  globalRateStore.__panelRateSweep = 0;
}
