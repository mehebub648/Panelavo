import type { NextRequest } from "next/server";
import { panelActorFromSession } from "@/server/auth/site-access";
import { requireFleetSuperAdmin } from "@/server/fleet/auth";
import {
  getFleetPublicState,
  refreshFleetServers,
} from "@/server/fleet/service";
import { fail, ok } from "@/server/http";

export async function GET(request: NextRequest) {
  try {
    const session = await requireFleetSuperAdmin({ allowDuringUpdate: true });
    const refresh = request.nextUrl.searchParams.get("refresh") !== "false";
    return ok({
      state: await getFleetPublicState(),
      servers: refresh
        ? await refreshFleetServers(panelActorFromSession(session))
        : Object.values((await getFleetPublicState()).health),
    });
  } catch (error) {
    return fail(error);
  }
}
