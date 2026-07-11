import { redirect } from "next/navigation";
import { destroySession, getSession, updateSession } from "./session";
import { decorateUser } from "./panel-roles";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { isPanelUpdateRunning } from "@/server/updates/panel-updater";

export async function requireUser(options: { allowDuringUpdate?: boolean } = {}) {
  const session = await getSession();
  if (!session)
    throw new AppError(
      "SESSION_EXPIRED",
      "Your session has expired. Please sign in again.",
      401,
    );
  if (!options.allowDuringUpdate && await isPanelUpdateRunning())
    throw new AppError("PANEL_UPDATING", "Panelavo is being updated. Try again when the update is complete.", 503);
  try {
    const user = await decorateUser(
      await getCloudPanelClient().getCurrentUser(session.record.cloudPanel),
    );
    await updateSession(session.id, { user });
    return { ...session, user };
  } catch (error) {
    if (error instanceof AppError && error.code === "SESSION_EXPIRED")
      await destroySession();
    throw error;
  }
}

export async function requireUserOrRedirect(options: { allowDuringUpdate?: boolean } = {}) {
  try {
    return await requireUser(options);
  } catch (error) {
    if (error instanceof AppError && error.status === 401)
      redirect("/login?reason=session-expired");
    throw error;
  }
}
