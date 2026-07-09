import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";

export async function GET() {
  try {
    const session = await requireUser();
    if (!["super-admin", "manager"].includes(session.user.panelRole ?? ""))
      throw new AppError("FORBIDDEN", "Server resources are available to administrators only.", 403);
    const resources = await getCloudPanelClient().getServerResources(
      session.record.cloudPanel,
    );
    return ok({ resources });
  } catch (error) {
    return fail(error);
  }
}
