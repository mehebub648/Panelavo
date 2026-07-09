// Client for the ippointer wildcard-DNS registration service. ippointer owns
// the mehebub.com Cloudflare zone and, when POSTed { ip }, creates the record
// *.<ip>.mehebub.com -> <ip>. It only honours a request whose source IP matches
// the submitted IP, so a server can register its OWN wildcard but not another's.
// This is why auto-registration is possible only for the mehebub.com base
// domain; any other base domain must be pointed by its own owner.

export const IPPOINTER_ENDPOINT = "https://ippointer.mehebub.com/";

// The single base domain whose wildcard ippointer can register on our behalf.
export const IPPOINTER_MANAGED_BASE = "mehebub.com";

export type IppointerResult = {
  ok: boolean;
  action?: string; // "created" | "exists" | ...
  record?: string; // "*.<ip>.mehebub.com"
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

// Register (or confirm) the wildcard *.<ip>.mehebub.com for this server. The
// request must originate from `ip` itself; the caller passes the server's own
// public IP.
export async function registerWildcard(ip: string): Promise<IppointerResult> {
  try {
    const response = await fetch(IPPOINTER_ENDPOINT, {
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
