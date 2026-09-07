import { createInviteToken } from "./invites";
import { AppError } from "@/server/cloudpanel/errors";
import type { PanelActor } from "./site-access";
import type { PanelRole } from "@/types/cloudpanel";
const PANEL_ROLES: PanelRole[] = ["super-admin", "manager", "admin", "user"];
export function createUserInvitation(
  actor: PanelActor,
  body: Record<string, unknown>,
  origin: string,
) {
  if (actor.user.panelRole !== "super-admin")
    throw new AppError("FORBIDDEN", "Super Admin access is required.", 403);
  const username = String(body.username ?? "").toLowerCase();
  const role = PANEL_ROLES.find((item) => item === String(body.role ?? ""));
  if (!role) throw new AppError("INVALID_REQUEST", "Unknown role.", 400);
  if (!/^[a-zA-Z0-9._-]{2,64}$/.test(username))
    throw new AppError("INVALID_REQUEST", "Enter a valid username.", 400);
  const email = String(body.email ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new AppError("INVALID_REQUEST", "Enter a valid email address.", 400);
  const token = createInviteToken({
    username,
    email,
    firstName: String(body.firstName ?? "")
      .trim()
      .slice(0, 64),
    lastName: String(body.lastName ?? "")
      .trim()
      .slice(0, 64),
    role,
    sites: String(body.sites ?? "")
      .split(",")
      .map((site) => site.trim())
      .filter(Boolean),
    timezone: /^[A-Za-z0-9_+\-/]{1,64}$/.test(String(body.timezone ?? ""))
      ? String(body.timezone)
      : "UTC",
    invitedBy: actor.user.username,
  });
  return { inviteUrl: `${origin}/invite/${token}` };
}
