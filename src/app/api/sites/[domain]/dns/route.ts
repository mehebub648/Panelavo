import { Resolver } from "node:dns/promises";
import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { fail, ok } from "@/server/http";
import { getZones } from "@/server/cloudflare/store";
import { pointDns, pointDnsError } from "@/server/cloudflare/point-dns";
import { getServerPublicIp } from "@/server/network/server-ip";
import { assertWriteRequest } from "@/server/security/request";

type Context = { params: Promise<{ domain: string }> };

export async function GET(request: NextRequest, context: Context) {
  try {
    const session = await requireUser();
    const { domain } = await context.params;
    const decodedDomain = decodeURIComponent(domain);

    const forwarded = request.headers.get("x-forwarded-host")?.split(":")[0];
    const serverIp = await getServerPublicIp(
      forwarded || request.nextUrl.hostname,
    );

    let ip = null;
    let pointed = false;
    try {
      const fastResolver = new Resolver();
      fastResolver.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);
      const records = await fastResolver.resolve4(decodedDomain);
      ip = records[0];
      pointed = ip === serverIp;
    } catch {
      // DNS resolution failed
      pointed = false;
    }

    let matchZone = null;
    try {
      const { zones } = await getZones(session.user.id);
      matchZone = zones.find(
        (z) => decodedDomain === z.name || decodedDomain.endsWith("." + z.name),
      );
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
    const serverIp = await getServerPublicIp(
      forwarded || request.nextUrl.hostname,
    );

    if (!raw.credentialId || !raw.zoneId) {
      throw new Error("Missing credentialId or zoneId");
    }

    const result = await pointDns({
      userId: session.user.id,
      domain: decodedDomain,
      serverIp,
      credentialId: String(raw.credentialId),
      zoneId: String(raw.zoneId),
      replace: raw.replace === true,
      proxied: raw.proxied === true,
    });
    if (!result.primaryOk) throw pointDnsError(result);

    const records = result.outcomes.flatMap((outcome) =>
      outcome.record ? [outcome.record] : [],
    );

    return ok({ records, record: records[0], changed: result.changed });
  } catch (error) {
    return fail(error);
  }
}
