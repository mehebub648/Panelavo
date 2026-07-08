const sensitive = new Set([
  "password",
  "siteUserPassword",
  "code",
  "cookie",
  "cookies",
  "csrf",
  "authorization",
]);

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitive.has(key) ? "[REDACTED]" : redact(item),
      ]),
    );
  }
  return value;
}

export function audit(
  action: string,
  result: "success" | "failure",
  context: Record<string, unknown> = {},
) {
  console.info(
    JSON.stringify(
      redact({
        timestamp: new Date().toISOString(),
        action,
        result,
        ...context,
      }),
    ),
  );
}
