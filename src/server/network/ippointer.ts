import { getPanelSettings } from "@/server/settings/store";

export type IppointerResult = {
  ok: boolean;
  action?: string; // "created" | "exists" | ...
  record?: string; // "*.<ip>.<configured-base-domain>"
  pointsTo?: string;
  error?: string;
};

// Parse ippointer's JSON body into our result shape. Exported for unit tests.
export function parseIppointerResponse(
  status: number,
  data: unknown,
): IppointerResult {
  const body = (data ?? {}) as Record<string, unknown>;
  const asString = (value: unknown) =>
    typeof value === "string" ? value : undefined;
  if (status >= 200 && status < 300 && body.success === true) {
    return {
      ok: true,
      action: asString(body.action),
      record: asString(body.record),
      pointsTo: asString(body.points_to),
    };
  }
  return {
    ok: false,
    error: asString(body.error) ?? `ippointer returned HTTP ${status}`,
  };
}

// Ask the explicitly configured service to register this server's wildcard.
// The caller passes the server's own public IP.
export async function registerWildcard(ip: string): Promise<IppointerResult> {
  try {
    const { wildcardRegistrationEndpoint } = await getPanelSettings();
    if (!wildcardRegistrationEndpoint)
      return {
        ok: false,
        error: "No wildcard registration service is configured.",
      };
    const endpoint = new URL(wildcardRegistrationEndpoint);
    if (endpoint.protocol !== "https:")
      return {
        ok: false,
        error: "The wildcard registration endpoint must use HTTPS.",
      };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ip }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await response.json().catch(() => ({}));
    return parseIppointerResponse(response.status, data);
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Could not reach the wildcard registration service.",
    };
  }
}
