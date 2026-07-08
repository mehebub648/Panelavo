import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { updateSiteSchema } from "@/schemas/sites";
import { assertWriteRequest } from "@/server/security/request";
import { fail, ok } from "@/server/http";

type Context = { params: Promise<{ domain: string }> };

export async function PATCH(request: NextRequest, context: Context) {
  try {
    assertWriteRequest(request);
    const session = await requireUser();
    const { domain } = await context.params;
    const input = updateSiteSchema.parse(await request.json());
    const site = await getCloudPanelClient().updateSite(
      session.record.cloudPanel,
      decodeURIComponent(domain),
      input,
    );
    return ok({ site });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  try {
    assertWriteRequest(request);
    const session = await requireUser();
    const { domain } = await context.params;
    await getCloudPanelClient().deleteSite(
      session.record.cloudPanel,
      decodeURIComponent(domain),
    );
    return ok({ deleted: true });
  } catch (error) {
    return fail(error);
  }
}
