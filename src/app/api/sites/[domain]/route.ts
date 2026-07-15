import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { updateSiteSchema } from "@/schemas/sites";
import { assertWriteRequest } from "@/server/security/request";
import { fail, ok } from "@/server/http";
import {
  changeSiteId,
  getLinkedServiceMeta,
  getSiteMeta,
  removeSiteMeta,
} from "@/server/sites/site-meta";
import {
  getSiteRootOverride,
  removeSiteRootOverride,
  setSiteRootOverride,
} from "@/server/sites/site-root-overlay";
import { AppError } from "@/server/cloudpanel/errors";
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
    const {
      applicationRootDirectory,
      servingDirectory,
      rootDirectory: legacyServingDirectory,
      ...otherSettings
    } = input;
    // Sites with a reserved id treat the app port as that id: moving the port
    // moves the reservation (and validates the target range) first.
    const meta = await getSiteMeta(decodedDomain);
    if (input.appPort !== undefined && meta && input.appPort !== meta.id)
      await changeSiteId(decodedDomain, input.appPort);
    const site = await getCloudPanelClient().updateSite(
      session.record.cloudPanel,
      decodedDomain,
      {
        ...otherSettings,
        applicationRootDirectory,
        rootDirectory: servingDirectory ?? legacyServingDirectory,
      },
    );
    if (applicationRootDirectory !== undefined)
      await setSiteRootOverride(decodedDomain, applicationRootDirectory);
    return ok({
      site: {
        ...site,
        applicationRootDirectory:
          applicationRootDirectory ??
          (await getSiteRootOverride(decodedDomain)) ??
          site.rootDirectory,
      },
      meta: await getSiteMeta(decodedDomain),
    });
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
    // Deleting a parent never cascades into its linked-service sites: the
    // operator detaches or deletes each service first, deliberately.
    const services = await getLinkedServiceMeta(decodedDomain);
    const serviceNames = Object.values(services).map(
      (service) => service.serviceName ?? "service",
    );
    if (serviceNames.length)
      throw new AppError(
        "INVALID_REQUEST",
        `This website still has linked services (${serviceNames.join(", ")}). Delete them from the Linked services section first.`,
        409,
      );

    await getCloudPanelClient().deleteSite(
      session.record.cloudPanel,
      decodedDomain,
    );
    // Free the reserved id/port so it can be reallocated.
    await removeSiteMeta(decodedDomain).catch(() => undefined);
    await removeSiteRootOverride(decodedDomain).catch(() => undefined);

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
