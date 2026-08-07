import {
  getZones,
  checkARecord,
  mutateRecord,
} from "@/server/cloudflare/store";
import {
  pointDns,
  pointDnsError,
  type PointDnsResult,
} from "@/server/cloudflare/point-dns";
import { dnsRecordNames } from "@/lib/domains";

export async function autoPointDns(
  userId: string,
  domain: string,
  serverIp: string,
): Promise<PointDnsResult> {
  const result = await pointDns({ userId, domain, serverIp });
  const error = pointDnsError(result);
  if (error) console.error("autoPointDns failed:", error);
  return result;
}

export async function autoDeleteDns(
  userId: string,
  domain: string,
  serverIp: string,
): Promise<boolean> {
  try {
    const { zones } = await getZones(userId);
    const zone = zones.find(
      (z) => domain === z.name || domain.endsWith("." + z.name),
    );
    if (!zone) return false;

    const names = dnsRecordNames(domain);
    let deleted = false;
    for (const name of names) {
      const existing = await checkARecord(
        userId,
        zone.credentialId,
        zone.id,
        name,
      );
      // ONLY delete if it currently points to THIS server.
      if (existing && existing.content === serverIp) {
        await mutateRecord(userId, zone.credentialId, zone.id, {
          action: "delete",
          id: existing.id,
        });
        deleted = true;
      }
    }
    return deleted;
  } catch (error) {
    console.error("autoDeleteDns failed:", error);
    return false;
  }
}
