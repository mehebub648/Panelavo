import { requireUser, requireUserOrRedirect } from "@/server/auth/require-user";
import { AppError } from "@/server/cloudpanel/errors";

export async function requireFleetSuperAdmin(
  options: { allowDuringUpdate?: boolean } = {},
) {
  const session = await requireUser(options);
  if (session.user.panelRole !== "super-admin")
    throw new AppError(
      "FORBIDDEN",
      "Fleet management is available to Super Admins only.",
      403,
    );
  return session;
}

export async function requireFleetSuperAdminOrRedirect(
  options: { allowDuringUpdate?: boolean } = {},
) {
  const session = await requireUserOrRedirect(options);
  return session.user.panelRole === "super-admin" ? session : null;
}
