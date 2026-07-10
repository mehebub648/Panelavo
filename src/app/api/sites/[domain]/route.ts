import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { updateSiteSchema } from "@/schemas/sites";
import { assertWriteRequest } from "@/server/security/request";
import { fail, ok } from "@/server/http";
import { changeSiteId, getSiteMeta } from "@/server/sites/site-meta";
import { autoDeleteDns } from "@/server/network/auto-dns";
import { getServerPublicIp } from "@/server/network/server-ip";

type Context = { params: Promise<{ domain: string }> };

export async function PATCH(request: NextRequest, context: Context) {
  try {
    assertWriteRequest(request);
    const session = await requireUser();
    const { domain } = await context.params;
    const decodedDomain = decodeURIComponent(domain);
    const input = updateSiteSchema.parse(await request.json());
    // Sites with a reserved id treat the app port as that id: moving the port
    // moves the reservation (and validates the target range) first.
    const meta = await getSiteMeta(decodedDomain);
    if (input.appPort !== undefined && meta && input.appPort !== meta.id)
      await changeSiteId(decodedDomain, input.appPort);
    const site = await getCloudPanelClient().updateSite(
      session.record.cloudPanel,
      decodedDomain,
      input,
    );
    return ok({ site, meta: await getSiteMeta(decodedDomain) });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  try {
    assertWriteRequest(request);
    const session = await requireUser();
    const { domain } = await context.params;
    const decodedDomain = decodeURIComponent(domain);
    const meta = await getSiteMeta(decodedDomain);
    
    await getCloudPanelClient().deleteSite(
      session.record.cloudPanel,
      decodedDomain,
    );

    // Background DNS cleanup
    void (async () => {
      try {
        const forwarded = request.headers.get("x-forwarded-host")?.split(":")[0];
        const serverIp = await getServerPublicIp(forwarded || request.nextUrl.hostname);
        
        await autoDeleteDns(session.user.id, decodedDomain, serverIp);
        if (meta?.aliases) {
          for (const alias of meta.aliases) {
            await autoDeleteDns(session.user.id, alias, serverIp);
          }
        }
      } catch (e: unknown) {
        console.error("Auto DNS delete failed on site removal:", e);
      }
    })();

    return ok({ deleted: true });
  } catch (error) {
    return fail(error);
  }
}
