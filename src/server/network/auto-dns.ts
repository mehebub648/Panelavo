import { getZones, setARecord, checkARecord, mutateRecord } from "@/server/cloudflare/store";
import { dnsRecordNames } from "@/lib/domains";

export async function autoPointDns(userId: string, domain: string, serverIp: string): Promise<boolean> {
  try {
    const { zones } = await getZones(userId);
    const zone = zones.find((z) => domain === z.name || domain.endsWith("." + z.name));
    if (!zone) return false;

    const names = dnsRecordNames(domain);
    let pointedAny = false;
    
    for (const name of names) {
      const existing = await checkARecord(userId, zone.credentialId, zone.id, name);
      // If no record exists, create it
      if (!existing) {
        await setARecord(userId, {
          credentialId: zone.credentialId,
          zoneId: zone.id,
          name,
          ip: serverIp,
          proxied: false,
          replace: false,
        });
        pointedAny = true;
      } else if (existing.content === serverIp) {
        // It's already pointed to us
        pointedAny = true;
      }
    }
    return pointedAny;
  } catch (error) {
    console.error("autoPointDns failed:", error);
    return false;
  }
}

export async function autoDeleteDns(userId: string, domain: string, serverIp: string): Promise<boolean> {
  try {
    const { zones } = await getZones(userId);
    const zone = zones.find((z) => domain === z.name || domain.endsWith("." + z.name));
    if (!zone) return false;

    const names = dnsRecordNames(domain);
    let deleted = false;
    for (const name of names) {
      const existing = await checkARecord(userId, zone.credentialId, zone.id, name);
      // ONLY delete if it currently points to THIS server.
      if (existing && existing.content === serverIp) {
        await mutateRecord(userId, zone.credentialId, zone.id, {
          action: "delete",
          id: existing.id
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
