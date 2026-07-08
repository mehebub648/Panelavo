import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";

export async function GET() {
  try {
    const session = await requireUser();
    if (!session.user.canCreateSites)
      throw new AppError(
        "FORBIDDEN",
        "You do not have permission to create websites.",
        403,
      );
    const options = await getCloudPanelClient().getSiteCreationOptions(
      session.record.cloudPanel,
    );
    return ok({ options });
  } catch (error) {
    return fail(error);
  }
}
