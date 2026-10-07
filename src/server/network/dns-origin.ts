import type { CloudflareRecord } from "@/server/cloudflare/store";
import {
  getAddressRecords,
  getZones,
} from "@/server/cloudflare/store";
import { resolveDnsStatus, type DnsStatus } from "@/server/network/dns";

function normalize(name: string) {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

export type DnsOriginTrace = {
  verified: boolean;
  chain: string[];
  record?: CloudflareRecord;
  proxied: boolean;
};

export async function traceDnsOrigin(
  name: string,
  serverIp: string,
  lookup: (name: string) => Promise<CloudflareRecord[]>,
): Promise<DnsOriginTrace> {
  let current = normalize(name);
  let firstRecord: CloudflareRecord | undefined;
  let proxied = false;
  const chain = [current];
  const seen = new Set<string>();

  for (let depth = 0; depth < 16 && !seen.has(current); depth++) {
    seen.add(current);
    const records = await lookup(current);
    firstRecord ??= records[0];
    proxied ||= records.some((record) => record.proxied);
    const matchingA = records.find(
      (record) =>
        record.type.toUpperCase() === "A" && record.content === serverIp,
    );
    if (matchingA)
      return {
        verified: true,
        chain,
        record: firstRecord ?? matchingA,
        proxied,
      };
    const cname = records.find(
      (record) => record.type.toUpperCase() === "CNAME",
    );
    if (!cname) break;
    current = normalize(cname.content);
    chain.push(current);
  }

  return { verified: false, chain, record: firstRecord, proxied };
}

export type DnsOriginStatus = DnsStatus & {
  publicIps: string[];
  publicResolved: boolean;
  managed: boolean;
  originVerified: boolean;
  proxied: boolean;
  pointed: boolean;
  chain: string[];
  providerError?: string;
};

/**
 * Verifies that each hostname resolves publicly and reaches this origin.
 * Connected Cloudflare zones are checked against their provider records so a
 * proxied hostname can be verified without comparing Cloudflare edge IPs to
 * the server IP. Names outside connected zones must resolve directly to it.
 */
export async function resolveDnsOriginStatus(
  userId: string,
  names: string[],
  serverIp: string,
): Promise<DnsOriginStatus[]> {
  const [zoneResult, publicStatuses] = await Promise.all([
    getZones(userId)
      .then(({ zones }) => ({ zones, failed: false }))
      .catch(() => ({ zones: [], failed: true })),
    resolveDnsStatus(names, serverIp),
  ]);
  const { zones } = zoneResult;

  return Promise.all(
    names.map(async (name, index) => {
      const normalized = normalize(name);
      const zone = zones
        .filter(
          (item) =>
            normalized === normalize(item.name) ||
            normalized.endsWith(`.${normalize(item.name)}`),
        )
        .sort((left, right) => right.name.length - left.name.length)[0];
      const publicStatus = publicStatuses[index];
      const publicIps = publicStatus?.ips ?? [];
      const publicResolved = publicIps.length > 0;
      const ip = publicStatus?.ip ?? null;
      const directVerified = publicIps.includes(serverIp);
      if (zoneResult.failed)
        return {
          name,
          ip,
          ips: publicIps,
          publicIps,
          publicResolved,
          managed: false,
          originVerified: directVerified,
          proxied: false,
          pointed: directVerified,
          chain: [normalized],
          providerError: "Cloudflare records could not be verified.",
        };
      if (!zone) {
        return {
          name,
          ip,
          ips: publicIps,
          publicIps,
          publicResolved,
          managed: false,
          originVerified: directVerified,
          proxied: false,
          pointed: directVerified,
          chain: [normalized],
        };
      }

      let trace: DnsOriginTrace;
      try {
        trace = await traceDnsOrigin(normalized, serverIp, async (target) => {
          const targetZone = zones
            .filter(
              (item) =>
                target === normalize(item.name) ||
                target.endsWith(`.${normalize(item.name)}`),
            )
            .sort((left, right) => right.name.length - left.name.length)[0];
          if (!targetZone) return [];
          return getAddressRecords(
            userId,
            targetZone.credentialId,
            targetZone.id,
            target,
          );
        });
      } catch {
        return {
          name,
          ip,
          ips: publicIps,
          publicIps,
          publicResolved,
          managed: true,
          originVerified: directVerified,
          proxied: false,
          pointed: directVerified,
          chain: [normalized],
          providerError: "Cloudflare records could not be verified.",
        };
      }
      const originVerified =
        directVerified || (publicResolved && trace.proxied && trace.verified);
      return {
        name,
        ip,
        ips: publicIps,
        publicIps,
        publicResolved,
        managed: true,
        originVerified,
        proxied: trace.proxied,
        pointed: originVerified,
        chain: trace.chain,
      };
    }),
  );
}
