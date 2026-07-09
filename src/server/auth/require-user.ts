import { redirect } from "next/navigation";
import { destroySession, getSession, updateSession } from "./session";
import { decorateUser } from "./panel-roles";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";

export async function requireUser() {
  const session = await getSession();
  if (!session)
    throw new AppError(
      "SESSION_EXPIRED",
      "Your session has expired. Please sign in again.",
      401,
    );
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

export async function requireUserOrRedirect() {
  try {
    return await requireUser();
  } catch (error) {
    if (error instanceof AppError && error.status === 401)
      redirect("/login?reason=session-expired");
    throw error;
  }
}
