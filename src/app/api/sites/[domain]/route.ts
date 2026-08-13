import type { NextRequest } from "next/server";
import { updateSiteSchema } from "@/schemas/sites";
import { requireUser } from "@/server/auth/require-user";
import { panelActorFromSession } from "@/server/auth/site-access";
import { fail, ok } from "@/server/http";
import { getRequestServerPublicIp } from "@/server/network/server-ip";
import { assertWriteRequest } from "@/server/security/request";
import {
  deleteManagedSite,
  updateManagedSite,
} from "@/server/sites/site-service";

type Context = { params: Promise<{ domain: string }> };

export async function PATCH(request: NextRequest, context: Context) {
  try {
    assertWriteRequest(request);
    const { domain } = await context.params;
    const session = await requireUser();
    const result = await updateManagedSite(
      panelActorFromSession(session),
      decodeURIComponent(domain),
      updateSiteSchema.parse(await request.json()),
    );
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  try {
    assertWriteRequest(request);
    const { domain } = await context.params;
    const session = await requireUser();
    const result = await deleteManagedSite(
      panelActorFromSession(session),
      decodeURIComponent(domain),
      { serverIp: await getRequestServerPublicIp(request) },
    );
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
