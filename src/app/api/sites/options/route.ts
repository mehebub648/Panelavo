import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";
import { getServerPublicIp } from "@/server/network/server-ip";
import { getBaseDomain } from "@/server/settings/store";
import { SITE_CATEGORIES, getAllSiteMeta, nextFreeId } from "@/server/sites/site-meta";

export async function GET() {
  try {
    const session = await requireUser();
    if (!session.user.canCreateSites)
      throw new AppError(
        "FORBIDDEN",
        "You do not have permission to create websites.",
        403,
      );
    const client = getCloudPanelClient();
    const [options, baseDomain, serverIp, meta, sites] = await Promise.all([
      client.getSiteCreationOptions(session.record.cloudPanel),
      getBaseDomain(),
      getServerPublicIp(),
      getAllSiteMeta(),
      client.listSites(session.record.cloudPanel).catch(() => []),
    ]);
    const reserved = [
      ...Object.values(meta).map((item) => item.id),
      ...sites
        .map((site) => site.appPort)
        .filter((port): port is number => typeof port === "number"),
    ];
    // nextId is a live preview for the form; the id is re-allocated on submit.
    const categories = SITE_CATEGORIES.map((category) => ({
      ...category,
      nextId: nextFreeId(category, reserved),
    }));
    return ok({ options, baseDomain, serverIp, categories });
  } catch (error) {
    return fail(error);
  }
}
