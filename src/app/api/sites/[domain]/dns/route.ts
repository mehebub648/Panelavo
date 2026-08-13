import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { panelActorFromSession } from "@/server/auth/site-access";
import { fail, ok } from "@/server/http";
import { getRequestServerPublicIp } from "@/server/network/server-ip";
import { assertWriteRequest } from "@/server/security/request";
import {
  getSiteDnsForActor,
  pointSiteDnsForActor,
} from "@/server/sites/site-domain-service";

type Context = { params: Promise<{ domain: string }> };

export async function GET(request: NextRequest, context: Context) {
  try {
    const { domain } = await context.params;
    const session = await requireUser();
    return ok(
      await getSiteDnsForActor(
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
    const session = await requireUser();
    return ok(
      await pointSiteDnsForActor(
        panelActorFromSession(session),
        decodeURIComponent(domain),
        await request.json(),
        await getRequestServerPublicIp(request),
      ),
    );
  } catch (error) {
    return fail(error);
  }
}
