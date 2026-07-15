import { getServerPublicIp } from "@/server/network/server-ip";
import { getBaseDomain } from "@/server/settings/store";

// The database manager is a dedicated CloudPanel PHP site running standalone
// phpMyAdmin on database.<server-ip>.<base-domain>, provisioned by setup.sh
// with its own Let's Encrypt certificate. It replaces links into CloudPanel's
// self-signed, firewalled port-8443 portal. Users authenticate with the
// database user's own credentials, so MySQL enforces per-site scope.
//
// setup.sh records the actually provisioned address in DATABASE_MANAGER_URL;
// without it the address is derived from the same wildcard convention the
// installer uses, so links keep working on installs that predate the variable.

export function getConfiguredDatabaseManagerUrl(): string | null {
  const configured = process.env.DATABASE_MANAGER_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function getDatabaseManagerUrl(): Promise<string | null> {
  const configured = getConfiguredDatabaseManagerUrl();
  if (configured) return configured;
  const [ip, baseDomain] = await Promise.all([
    getServerPublicIp(),
    getBaseDomain(),
  ]);
  if (!ip || !baseDomain) return null;
  return `https://database.${ip}.${baseDomain}`;
}

// The site hosting the database manager is infrastructure: deleting or
// editing it from the panel would break every "Manage" link, so it is hidden
// and protected exactly like the panel's own site. Only the explicitly
// configured address is trusted here — the derived fallback could collide
// with a legitimate user site named "database.…" on installs that never
// provisioned the manager.
export function isDatabaseManagerDomain(domain: string): boolean {
  const configured = getConfiguredDatabaseManagerUrl();
  if (!configured) return false;
  return new URL(configured).hostname === domain.trim().toLowerCase();
}
