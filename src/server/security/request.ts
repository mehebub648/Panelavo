import { NextRequest } from "next/server";
import { AppError } from "@/server/cloudpanel/errors";

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
  const origin = request.headers.get("origin");
  const expected = process.env.APP_BASE_URL;
  if (
    origin &&
    expected &&
    new URL(origin).origin !== new URL(expected).origin
  ) {
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
};
const store = (globalRateStore.__panelRateLimits ??= new Map());

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
  sweep(now);
  const entry = store.get(key);
  if (!entry || entry.reset < now) {
    store.set(key, { count: 1, reset: now + windowMs });
    return;
  }
  if (entry.count >= limit)
    throw new AppError(
      "INVALID_REQUEST",
      "Too many attempts. Please wait and try again.",
      429,
    );
  entry.count += 1;
}

export function clientKey(request: NextRequest) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local"
  );
}
