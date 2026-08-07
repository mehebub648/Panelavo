import { dnsRecordNames } from "@/lib/domains";
import { AppError } from "@/server/cloudpanel/errors";
import {
  checkARecord,
  getZones,
  setARecord,
  type CloudflareRecord,
} from "@/server/cloudflare/store";

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
 * Ensures the primary A record and its applicable www companion point at this
 * server. Failures are returned as data so callers choose whether to throw,
 * log, or continue with a partial best-effort result.
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
    const names = dnsRecordNames(domain);
    const outcomes = await Promise.all(
      names.map(async (name): Promise<PointDnsOutcome> => {
        try {
          const existing = await checkARecord(
            userId,
            selectedCredentialId,
            selectedZoneId,
            name,
          );
          if (existing?.content === serverIp)
            return { name, status: "unchanged", record: existing };

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
            status: existing ? "updated" : "created",
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
