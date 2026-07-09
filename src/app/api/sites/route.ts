import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { createSiteSchema } from "@/schemas/sites";
import { fail, ok } from "@/server/http";
import { audit } from "@/server/security/log";
import { assertWriteRequest, rateLimit } from "@/server/security/request";
import { setARecord } from "@/server/cloudflare/store";

export async function GET() {
  const requestId = randomUUID();
  try {
    const session = await requireUser();
    const sites = await getCloudPanelClient().listSites(
      session.record.cloudPanel,
    );
    return ok({ sites });
  } catch (error) {
    audit("sites.list", "failure", { requestId });
    return fail(error);
  }
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  try {
    assertWriteRequest(request);
    const session = await requireUser();
    rateLimit(`site-create:${session.user.id}`, 5, 10 * 60_000);
    if (!session.user.canCreateSites)
      return fail(
        new (await import("@/server/cloudpanel/errors")).AppError(
          "FORBIDDEN",
          "You do not have permission to create websites.",
          403,
        ),
      );
    const raw = await request.json();
    const input = createSiteSchema.parse(raw);
    audit("sites.create.request", "success", {
      requestId,
      user: session.user.username,
      siteType: input.type,
      domain: input.domain,
    });
    const site = await getCloudPanelClient().createSite(
      session.record.cloudPanel,
      input,
    );
    // Panel admins are restricted CloudPanel users: assign the new site to
    // them immediately so it appears in (and stays limited to) their own list.
    if (session.user.panelRole === "admin")
      await getCloudPanelClient().assignSite(session.record.cloudPanel, input.domain);
    if (raw.dns?.credentialId && raw.dns?.zoneId) {
      try {
        const forwarded = request.headers.get("x-forwarded-host")?.split(":")[0];
        const ip = process.env.SERVER_PUBLIC_IP || forwarded || request.nextUrl.hostname;
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error("SERVER_PUBLIC_IP must be configured to create DNS records.");
        await setARecord(session.user.id, { credentialId: String(raw.dns.credentialId), zoneId: String(raw.dns.zoneId), name: input.domain, ip, replace: raw.dns.replace === true, proxied: raw.dns.proxied === true });
      } catch (dnsError) {
        await getCloudPanelClient().deleteSite(session.record.cloudPanel, input.domain).catch(() => undefined);
        throw dnsError;
      }
    }
    audit("sites.create", "success", {
      requestId,
      user: session.user.username,
      siteType: input.type,
      domain: input.domain,
    });
    return ok({ site }, { status: 201 });
  } catch (error) {
    audit("sites.create", "failure", { requestId });
    return fail(error);
  }
}
