import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";

async function storage(refresh: boolean) {
  const session = await requireUser();
  if (!["super-admin", "manager"].includes(session.user.panelRole ?? ""))
    throw new AppError(
      "FORBIDDEN",
      "Server storage is available to administrators only.",
      403,
    );
  return getCloudPanelClient().getServerStorage(
    session.record.cloudPanel,
    refresh,
  );
}

export async function GET() {
  try {
    return ok({ storage: await storage(false) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST() {
  try {
    return ok({ storage: await storage(true) });
  } catch (error) {
    return fail(error);
  }
}
