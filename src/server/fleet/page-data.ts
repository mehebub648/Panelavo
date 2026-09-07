import { cache } from "react";
import { requireFleetSuperAdmin } from "./auth";
import { dispatchFleetAction } from "./service";
import { panelActorFromSession } from "@/server/auth/site-access";
import type { CloudPanelSite } from "@/types/cloudpanel";

export const getFleetSiteForRender = cache(
  async (serverId: string, domain: string) => {
    const session = await requireFleetSuperAdmin({ allowDuringUpdate: true });
    return (await dispatchFleetAction(
      serverId,
      "site.get",
      { domain },
      panelActorFromSession(session),
    )) as CloudPanelSite;
  },
);
