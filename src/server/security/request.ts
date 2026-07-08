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
};
const store = (globalRateStore.__panelRateLimits ??= new Map());

export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
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
