import { randomBytes } from "node:crypto";
import { resolveDnsStatus, systemWildcardDomain } from "@/server/network/dns";
import { getServerPublicIp } from "@/server/network/server-ip";
import { DEFAULT_BASE_DOMAIN, getBaseDomain } from "@/server/settings/store";
import { IPPOINTER_MANAGED_BASE } from "@/server/network/ippointer";

// Whether the panel is usable: a base domain is configured AND the wildcard
// *.<serverIp>.<baseDomain> resolves to this server. The whole site scheme
// (site-<id>.<ip>.<base>) depends on that one record, so the panel gates access
// on it until it is live.

export type SystemStatus = {
  baseDomain: string;
  serverIp: string;
  wildcardDomain: string; // *.<ip>.<base>
  probeName: string; // the (random) label used for the readiness check
  ready: boolean;
  pointed: boolean; // wildcard resolves to serverIp
  resolvedIps: string[];
  canAutoRegister: boolean; // base domain is the ippointer-managed zone
  defaultBaseDomain: string; // vendor-provided fallback base domain
  reason: string; // human explanation when not ready ("" when ready)
};

// Probing a wildcard with a fixed label risks a stale *negative* DNS cache
// entry (from a lookup made before the record existed) making a working
// wildcard look broken. A fresh random label is never negatively cached, so it
// reflects the true current state.
function randomProbe(serverIp: string, baseDomain: string) {
  return `probe-${randomBytes(6).toString("hex")}.${serverIp}.${baseDomain}`.toLowerCase();
}

const READY_TTL_MS = 10 * 60_000;
const NOT_READY_TTL_MS = 30_000;
let cached: { status: SystemStatus; at: number } | null = null;

export function invalidateSystemStatus() {
  cached = null;
}

export async function getSystemStatus(
  options: { refresh?: boolean } = {},
): Promise<SystemStatus> {
  if (!options.refresh && cached) {
    const ttl = cached.status.ready ? READY_TTL_MS : NOT_READY_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.status;
  }

  const baseDomain = await getBaseDomain();
  const serverIp = await getServerPublicIp();
  const wildcardDomain =
    baseDomain && serverIp ? systemWildcardDomain(serverIp, baseDomain) : "";
  const probeName =
    baseDomain && serverIp ? randomProbe(serverIp, baseDomain) : "";

  let pointed = false;
  let resolvedIps: string[] = [];
  if (probeName) {
    const [status] = await resolveDnsStatus([probeName], serverIp);
    pointed = status.pointed;
    resolvedIps = status.ips;
  }

  const ready = Boolean(baseDomain) && pointed;
  const reason = !baseDomain
    ? "No base domain is configured yet."
    : !serverIp
      ? "The server's public IP address could not be determined."
      : !pointed
        ? `The wildcard ${wildcardDomain} is not resolving to this server (${serverIp}) yet.`
        : "";

  const status: SystemStatus = {
    baseDomain,
    serverIp,
    wildcardDomain,
    probeName,
    ready,
    pointed,
    resolvedIps,
    canAutoRegister: baseDomain === IPPOINTER_MANAGED_BASE,
    defaultBaseDomain: DEFAULT_BASE_DOMAIN,
    reason,
  };
  cached = { status, at: Date.now() };
  return status;
}
