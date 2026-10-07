import { AppError } from "@/server/cloudpanel/errors";
import {
  getAddressRecords,
  getZones,
  setARecord,
  type CloudflareRecord,
} from "@/server/cloudflare/store";
import { traceDnsOrigin } from "@/server/network/dns-origin";
import { resolveDnsStatus } from "@/server/network/dns";

export type PointDnsOutcome = {
  name: string;
  status: "created" | "updated" | "unchanged" | "failed";
  record?: CloudflareRecord;
  error?: unknown;
};

export type PointDnsResult = {
  managed: boolean;
  primaryOk: boolean;
  changed: boolean;
  outcomes: PointDnsOutcome[];
};

export type PointDnsOptions = {
  userId: string;
  domain: string;
  serverIp: string;
  credentialId?: string;
  zoneId?: string;
  replace?: boolean;
  proxied?: boolean;
};

function failed(domain: string, error: unknown): PointDnsResult {
  return {
    managed: false,
    primaryOk: false,
    changed: false,
    outcomes: [{ name: domain, status: "failed", error }],
  };
}

/**
 * Ensures the requested hostname's A record points at this server. Callers
 * invoke this once for every hostname the website actually serves.
 */
export async function pointDns(
  options: PointDnsOptions,
): Promise<PointDnsResult> {
  const {
    userId,
    domain,
    serverIp,
    replace = false,
    proxied = false,
  } = options;
  let credentialId = options.credentialId;
  let zoneId = options.zoneId;

  try {
    if (Boolean(credentialId) !== Boolean(zoneId))
      return failed(
        domain,
        new AppError(
          "INVALID_REQUEST",
          "Cloudflare credentialId and zoneId must be supplied together.",
          400,
        ),
      );

    if (!credentialId || !zoneId) {
      const { zones } = await getZones(userId);
      const zone = zones
        .filter(
          (item) => domain === item.name || domain.endsWith("." + item.name),
        )
        .sort((left, right) => right.name.length - left.name.length)[0];
      if (!zone) return failed(domain, undefined);
      credentialId = zone.credentialId;
      zoneId = zone.id;
    }

    if (!credentialId || !zoneId)
      return failed(
        domain,
        new AppError(
          "INVALID_REQUEST",
          "Cloudflare zone was not resolved.",
          400,
        ),
      );
    const selectedCredentialId = credentialId;
    const selectedZoneId = zoneId;
    const names = [domain];
    const outcomes = await Promise.all(
      names.map(async (name): Promise<PointDnsOutcome> => {
        try {
          const existing = await getAddressRecords(
            userId,
            selectedCredentialId,
            selectedZoneId,
            name,
          );
          const trace = await traceDnsOrigin(name, serverIp, (target) =>
            getAddressRecords(
              userId,
              selectedCredentialId,
              selectedZoneId,
              target,
            ),
          );
          if (trace.verified)
            return { name, status: "unchanged", record: trace.record };
          const cname = existing.find(
            (record) => record.type.toUpperCase() === "CNAME",
          );
          if (cname) {
            const [publicStatus] = await resolveDnsStatus([name], serverIp);
            if (publicStatus?.ips.includes(serverIp))
              return { name, status: "unchanged", record: cname };
            throw new AppError(
              "DOMAIN_ALREADY_EXISTS",
              `${name} has a CNAME to ${cname.content} that does not lead to this server. Change or remove that CNAME in Cloudflare, then retry.`,
              409,
            );
          }

          const record = await setARecord(userId, {
            credentialId: selectedCredentialId,
            zoneId: selectedZoneId,
            name,
            ip: serverIp,
            replace,
            proxied,
          });
          return {
            name,
            status: existing.length ? "updated" : "created",
            record,
          };
        } catch (error) {
          return { name, status: "failed", error };
        }
      }),
    );

    return {
      managed: true,
      primaryOk: outcomes[0]?.status !== "failed",
      changed: outcomes.some(
        (outcome) =>
          outcome.status === "created" || outcome.status === "updated",
      ),
      outcomes,
    };
  } catch (error) {
    return failed(domain, error);
  }
}

export function pointDnsError(result: PointDnsResult) {
  return result.outcomes.find((outcome) => outcome.status === "failed")?.error;
}
