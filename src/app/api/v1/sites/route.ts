import type { NextRequest } from "next/server";
import { authenticateApiToken } from "@/server/auth/api-tokens";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { fail, ok } from "@/server/http";
import { rateLimit } from "@/server/security/request";

export async function GET(request: NextRequest) {
  try {
    const actor = await authenticateApiToken(request, "sites:read");
    rateLimit(`api-token:${actor.id}`, 120, 60_000);
    return ok({
      sites: await getCloudPanelClient().listSites(actor.cloudPanel),
    });
  } catch (error) {
    return fail(error);
  }
}
