import type { AuditQuery, AuditResult } from "@/server/security/log";

function positiveInteger(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function startOfDay(value: string | null) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value + "T00:00:00.000Z"
    : value || undefined;
}

function endOfDay(value: string | null) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value + "T23:59:59.999Z"
    : value || undefined;
}

export function auditQueryFromSearchParams(
  params: URLSearchParams,
): AuditQuery {
  const result = params.get("result");
  return {
    page: positiveInteger(params.get("page"), 1),
    pageSize: Math.min(100, positiveInteger(params.get("pageSize"), 25)),
    action: params.get("action")?.trim() || undefined,
    actor: params.get("user")?.trim() || undefined,
    target: params.get("site")?.trim() || undefined,
    from: startOfDay(params.get("from")),
    to: endOfDay(params.get("to")),
    result:
      result === "success" || result === "failure"
        ? (result as AuditResult)
        : undefined,
  };
}
