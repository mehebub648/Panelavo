import type { NextRequest } from "next/server";
import { updateSiteSchema } from "@/schemas/sites";
import { assertWriteRequest } from "@/server/security/request";
import { fail, ok } from "@/server/http";
import {
  changeSiteId,
  assertSiteIdChange,
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
import { requireWritableSite } from "@/server/auth/site-access";
import { autoDeleteDns } from "@/server/network/auto-dns";
import { getRequestServerPublicIp } from "@/server/network/server-ip";
import { removeBackupSchedule } from "@/server/backups/schedule";
import { removeOffsiteDestination } from "@/server/backups/offsite";
import { removeUptime } from "@/server/monitoring/store";

type Context = { params: Promise<{ domain: string }> };

export async function PATCH(request: NextRequest, context: Context) {
  try {
    assertWriteRequest(request);
    const { domain } = await context.params;
    const decodedDomain = decodeURIComponent(domain);
    const { session, client } = await requireWritableSite(decodedDomain);
    const input = updateSiteSchema.parse(await request.json());
    const {
      applicationRootDirectory,
      servingDirectory,
      rootDirectory: legacyServingDirectory,
      ...otherSettings
    } = input;
    // Sites with a reserved id treat the app port as that id: moving the port
    // moves the reservation. Validate before touching either system, update
    // the authoritative site first, and only then persist the local overlay.
    const meta = await getSiteMeta(decodedDomain);
    const previousId = meta?.id;
    const movingId =
      input.appPort !== undefined &&
      previousId !== undefined &&
      input.appPort !== previousId;
    if (movingId) await assertSiteIdChange(decodedDomain, input.appPort!);
    const site = await client.updateSite(
      session.record.cloudPanel,
      decodedDomain,
      {
        ...otherSettings,
        applicationRootDirectory,
        rootDirectory: servingDirectory ?? legacyServingDirectory,
      },
    );
    if (movingId) {
      try {
        await changeSiteId(decodedDomain, input.appPort!);
      } catch (error) {
        await client
          .updateSite(session.record.cloudPanel, decodedDomain, {
            appPort: previousId,
          })
          .catch(() => undefined);
        throw error;
      }
    }
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
    const { domain } = await context.params;
    const decodedDomain = decodeURIComponent(domain);
    const { session, client } = await requireWritableSite(decodedDomain);
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

    await client.deleteSite(session.record.cloudPanel, decodedDomain);
    // Free the reserved id/port so it can be reallocated.
    await removeSiteMeta(decodedDomain).catch(() => undefined);
    await removeSiteRootOverride(decodedDomain).catch(() => undefined);
    await removeBackupSchedule(decodedDomain).catch(() => undefined);
    await removeOffsiteDestination(decodedDomain).catch(() => undefined);
    await removeUptime(decodedDomain).catch(() => undefined);

    // Background DNS cleanup
    void (async () => {
      try {
        const serverIp = await getRequestServerPublicIp(request);

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
