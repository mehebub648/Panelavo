import { getSession } from "@/server/auth/session";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";
import { isPanelUpdateRunning } from "@/server/updates/panel-updater";

export async function GET() {
  try {
    if (!await getSession())
      throw new AppError("SESSION_EXPIRED", "Your session has expired. Please sign in again.", 401);
    return ok({ running: await isPanelUpdateRunning() });
  } catch (error) {
    return fail(error);
  }
}
