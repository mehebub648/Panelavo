import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { resolveDnsStatus } from "@/server/network/dns";
import { autoPointDns } from "@/server/network/auto-dns";
import type { CloudPanelSession } from "@/types/cloudpanel";

// Certificate lifecycle policy: every panel-created site always carries a
// Let's Encrypt certificate for its system domain (site-<id>.<ip>.<base>,
// whose generated hostname is verified during setup), topped up with every
// alias that currently points at this server. Aliases that do not point here
// yet are skipped with a warning instead of failing the whole issuance — the
// user re-runs the check once DNS is fixed and the certificate grows to cover
// them.

export type SslPlan = {
  // SAN names to request alongside the system domain (all verified pointed).
  san: string[];
  // Names (aliases or www companions) skipped because they do not resolve here.
  unpointed: string[];
  warnings: string[];
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Point what we can, then split the site's alias names into
 * pointed (certifiable) and unpointed (warned) sets.
 *
 * When `autoPoint` is set, aliases in a Cloudflare zone the panel user has
 * credentials for are pointed first; freshly created records get a short
 * propagation grace period before the final verdict.
 */
export async function planSiteSsl(options: {
  userId: string;
  systemDomain: string;
  aliases: string[];
  serverIp: string;
  autoPoint?: boolean;
}): Promise<SslPlan> {
  const { userId, systemDomain, aliases, serverIp, autoPoint } = options;
  const names = Array.from(
    new Set(aliases.filter((name) => name !== systemDomain)),
  );
  if (!names.length) return { san: [], unpointed: [], warnings: [] };

  let createdRecords = false;
  if (autoPoint) {
    for (const alias of aliases) {
      if (alias === systemDomain) continue;
      // Best effort: only succeeds when a connected Cloudflare token covers
      // the alias's zone. Every name here is also served by the site's vhost.
      const result = await autoPointDns(userId, alias, serverIp);
      createdRecords = result.changed || createdRecords;
    }
  }

  let statuses = await resolveDnsStatus(names, serverIp);
  if (createdRecords && statuses.some((status) => !status.pointed)) {
    // Give just-created records a moment to reach the public resolvers.
    await sleep(2_500);
    statuses = await resolveDnsStatus(names, serverIp);
  }

  const san = statuses
    .filter((status) => status.pointed)
    .map((status) => status.name);
  const unpointed = statuses
    .filter((status) => !status.pointed)
    .map((status) => status.name);
  const warnings = unpointed.map(
    (name) =>
      `${name} does not point to this server (${serverIp}) yet, so it was left out of the SSL certificate. Point it here, then use "Recheck DNS & secure" to include it.`,
  );
  return { san, unpointed, warnings };
}

/**
 * True when an installed Let's Encrypt certificate already covers every
 * desired name — re-issuing then would only burn Let's Encrypt's duplicate
 * certificate rate limit.
 */
export async function certificateAlreadyCovers(
  session: CloudPanelSession,
  systemDomain: string,
  desired: string[],
): Promise<boolean> {
  const client = getCloudPanelClient();
  let data: CertificateList;
  try {
    data = (await client.getSiteSection(
      session,
      systemDomain,
      "certificates",
    )) as CertificateList;
  } catch {
    return false; // cannot tell — issue rather than risk serving without SSL
  }
  const cert = (data.items ?? []).find(
    (item) =>
      isLetsEncrypt(item.type) &&
      covers(item.domains, desired) &&
      (!item.expiresAt ||
        new Date(item.expiresAt).getTime() >= Date.now() + 7 * 86_400_000) &&
      (item.default || item.id),
  );
  if (!cert) return false;
  if (!cert.default)
    await client.manageSiteSection(session, systemDomain, "certificates", {
      action: "set-default",
      id: cert.id,
    });
  return true;
}

type CertificateList = {
  items?: {
    id?: string;
    type?: string;
    domains?: string[];
    expiresAt?: string | null;
    default?: boolean;
  }[];
};

const isLetsEncrypt = (type: unknown) =>
  ["2", "lets-encrypt"].includes(String(type ?? "").toLowerCase());

function covers(domains: string[] | undefined, desired: string[]) {
  const have = new Set((domains ?? []).map((name) => name.toLowerCase()));
  return desired.every((name) => have.has(name.toLowerCase()));
}

/**
 * Issue the Let's Encrypt certificate for the system domain plus SAN, then
 * make sure the fresh certificate — not CloudPanel's self-signed placeholder —
 * is the site's default. Self-signed is never treated as configured SSL.
 */
export async function issueSiteSsl(
  session: CloudPanelSession,
  systemDomain: string,
  san: string[],
): Promise<void> {
  const client = getCloudPanelClient();
  // manageSiteSection returns the refreshed certificates list after issuing.
  const data = (await client.manageSiteSection(
    session,
    systemDomain,
    "certificates",
    san.length
      ? { action: "lets-encrypt", subjectAlternativeName: san.join(",") }
      : { action: "lets-encrypt" },
  )) as CertificateList;

  const freshest = (data.items ?? [])
    .filter(
      (cert) =>
        isLetsEncrypt(cert.type) &&
        cert.id &&
        covers(cert.domains, [systemDomain, ...san]),
    )
    .sort(
      (a, b) =>
        new Date(b.expiresAt ?? 0).getTime() -
        new Date(a.expiresAt ?? 0).getTime(),
    )[0];
  if (!freshest)
    throw new AppError(
      "INTERNAL_ERROR",
      "Certificate issuance did not return a certificate covering the requested addresses. Recheck DNS and retry HTTPS setup.",
      502,
    );
  if (!freshest.default)
    await client.manageSiteSection(session, systemDomain, "certificates", {
      action: "set-default",
      id: freshest.id,
    });
}
