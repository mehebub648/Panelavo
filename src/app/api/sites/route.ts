import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { createSiteSchema } from "@/schemas/sites";
import { requireUser } from "@/server/auth/require-user";
import { panelActorFromSession } from "@/server/auth/site-access";
import { fail, ok } from "@/server/http";
import { getRequestServerPublicIp } from "@/server/network/server-ip";
import { audit } from "@/server/security/log";
import { assertWriteRequest, rateLimit } from "@/server/security/request";
import {
  createManagedSite,
  listManagedSites,
} from "@/server/sites/site-service";

export async function GET() {
  const requestId = randomUUID();
  try {
    const session = await requireUser();
    return ok({
      sites: await listManagedSites(panelActorFromSession(session)),
    });
  } catch (error) {
    void audit("sites.list", "failure", { requestId });
    return fail(error);
  }
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  try {
    assertWriteRequest(request);
    const session = await requireUser();
    rateLimit(`site-create:${session.user.id}`, 5, 10 * 60_000);
    const input = createSiteSchema.parse(await request.json());
    const result = await createManagedSite(
      panelActorFromSession(session),
      input,
      { serverIp: await getRequestServerPublicIp(request) },
    );
    void audit("sites.create", "success", {
      requestId,
      user: session.user.username,
      siteType: input.type,
      domain: result.site.domain,
      siteId: result.site.meta.id,
    });
    return ok(result, { status: 201 });
  } catch (error) {
    void audit("sites.create", "failure", { requestId });
    return fail(error);
  }
}
