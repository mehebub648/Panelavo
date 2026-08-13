import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { panelActorFromSession } from "@/server/auth/site-access";
import { fail, ok } from "@/server/http";
import { getRequestServerPublicIp } from "@/server/network/server-ip";
import { audit } from "@/server/security/log";
import { assertWriteRequest } from "@/server/security/request";
import {
  getSiteDomainsForActor,
  manageSiteDomainsForActor,
  siteDomainActionSchema,
} from "@/server/sites/site-domain-service";

type Context = { params: Promise<{ domain: string }> };

export async function GET(request: NextRequest, context: Context) {
  try {
    const { domain } = await context.params;
    const session = await requireUser();
    return ok(
      await getSiteDomainsForActor(
        panelActorFromSession(session),
        decodeURIComponent(domain),
        await getRequestServerPublicIp(request),
      ),
    );
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    assertWriteRequest(request);
    const { domain } = await context.params;
    const decodedDomain = decodeURIComponent(domain);
    const session = await requireUser();
    const submitted: unknown = await request.json();
    const data = await manageSiteDomainsForActor(
      panelActorFromSession(session),
      decodedDomain,
      submitted,
      await getRequestServerPublicIp(request),
    );
    audit("sites.domains", "success", {
      user: session.user.username,
      domain: decodedDomain,
      action: siteDomainActionSchema.parse(submitted).action,
    });
    return ok(data);
  } catch (error) {
    audit("sites.domains", "failure", {});
    return fail(error);
  }
}
