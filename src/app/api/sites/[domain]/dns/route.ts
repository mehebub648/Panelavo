import { resolve4 } from "node:dns/promises";
import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { fail, ok } from "@/server/http";
import { getZones, setARecord } from "@/server/cloudflare/store";
import { assertWriteRequest } from "@/server/security/request";

type Context = { params: Promise<{ domain: string }> };

export async function GET(request: NextRequest, context: Context) {
  try {
    const session = await requireUser();
    const { domain } = await context.params;
    
    const forwarded = request.headers.get("x-forwarded-host")?.split(":")[0];
    const serverIp = process.env.SERVER_PUBLIC_IP || forwarded || request.nextUrl.hostname;
    
    let ip = null;
    let pointed = false;
    try {
      const records = await resolve4(decodeURIComponent(domain));
      ip = records[0];
      pointed = ip === serverIp;
    } catch (e) {
      // DNS resolution failed
      pointed = false;
    }
    
    let matchZone = null;
    try {
      const decodedDomain = decodeURIComponent(domain);
      const { zones } = await getZones(session.user.id);
      matchZone = zones.find((z) => decodedDomain === z.name || decodedDomain.endsWith("." + z.name));
    } catch (e) {
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
    const raw = await request.json();
    
    const forwarded = request.headers.get("x-forwarded-host")?.split(":")[0];
    const serverIp = process.env.SERVER_PUBLIC_IP || forwarded || request.nextUrl.hostname;
    
    if (!raw.credentialId || !raw.zoneId) {
      throw new Error("Missing credentialId or zoneId");
    }
    
    const record = await setARecord(session.user.id, {
      credentialId: String(raw.credentialId),
      zoneId: String(raw.zoneId),
      name: decodeURIComponent(domain),
      ip: serverIp,
      replace: raw.replace === true,
      proxied: raw.proxied === true,
    });
    
    return ok({ record });
  } catch (error) {
    return fail(error);
  }
}
