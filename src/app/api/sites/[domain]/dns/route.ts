import { resolve4 } from "node:dns/promises";
import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { fail, ok } from "@/server/http";
import { getZones, setARecord } from "@/server/cloudflare/store";
import { getServerPublicIp } from "@/server/network/server-ip";
import { assertWriteRequest } from "@/server/security/request";
import { dnsRecordNames } from "@/lib/domains";

type Context = { params: Promise<{ domain: string }> };

export async function GET(request: NextRequest, context: Context) {
  try {
    const session = await requireUser();
    const { domain } = await context.params;
    const decodedDomain = decodeURIComponent(domain);

    const forwarded = request.headers.get("x-forwarded-host")?.split(":")[0];
    const serverIp = await getServerPublicIp(forwarded || request.nextUrl.hostname);

    let ip = null;
    let pointed = false;
    try {
      const records = await resolve4(decodedDomain);
      ip = records[0];
      pointed = ip === serverIp;
    } catch {
      // DNS resolution failed
      pointed = false;
    }

    let matchZone = null;
    try {
      const { zones } = await getZones(session.user.id);
      matchZone = zones.find((z) => decodedDomain === z.name || decodedDomain.endsWith("." + z.name));
    } catch {
      // ignore if cloudflare is not setup
    }

    return ok({
      pointed,
      ip,
      serverIp,
      zoneId: matchZone?.id || null,
      credentialId: matchZone?.credentialId || null,
    });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    assertWriteRequest(request);
    const session = await requireUser();
    const { domain } = await context.params;
    const decodedDomain = decodeURIComponent(domain);
    const raw = await request.json();

    const forwarded = request.headers.get("x-forwarded-host")?.split(":")[0];
    const serverIp = await getServerPublicIp(forwarded || request.nextUrl.hostname);

    if (!raw.credentialId || !raw.zoneId) {
      throw new Error("Missing credentialId or zoneId");
    }

    // Point the bare domain plus a www companion when the site is the zone
    // apex; a plain subdomain only points itself.
    const names = dnsRecordNames(decodedDomain);
    const results = await Promise.allSettled(
      names.map((name) =>
        setARecord(session.user.id, {
          credentialId: String(raw.credentialId),
          zoneId: String(raw.zoneId),
          name,
          ip: serverIp,
          replace: raw.replace === true,
          proxied: raw.proxied === true,
        }),
      ),
    );

    // The primary name (first) must succeed; the www companion is best-effort
    // (e.g. it may already exist pointing elsewhere).
    const primary = results[0];
    if (primary.status === "rejected") throw primary.reason;

    const records = results
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof setARecord>>> => r.status === "fulfilled")
      .map((r) => r.value);

    return ok({ records, record: records[0] });
  } catch (error) {
    return fail(error);
  }
}
