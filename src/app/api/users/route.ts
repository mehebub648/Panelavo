import type { NextRequest } from "next/server";
import type { PanelRole } from "@/types/cloudpanel";
import { requireUser } from "@/server/auth/require-user";
import { cloudRoleFor, setPanelAdmin } from "@/server/auth/panel-roles";
import { createInviteToken } from "@/server/auth/invites";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { assertWriteRequest, rateLimit } from "@/server/security/request";
import { fail, ok } from "@/server/http";

const PANEL_ROLES: PanelRole[] = ["super-admin", "manager", "admin", "user"];

export async function GET() {
  try {
    const session = await requireUser();
    if (session.user.panelRole !== "super-admin")
      throw new AppError("FORBIDDEN", "Users are available to administrators only.", 403);
    return ok({ users: await getCloudPanelClient().listUsers(session.record.cloudPanel) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertWriteRequest(request);
    const session = await requireUser();
    if (session.user.panelRole !== "super-admin")
      throw new AppError("FORBIDDEN", "Users are available to administrators only.", 403);
    rateLimit(`users:${session.user.id}`, 10, 60_000);
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action ?? "");
    const username = String(body.username ?? "").toLowerCase();

    // Passwordless onboarding: sign the whole account definition into a JWT.
    // The account is created only when the invitee opens the link and sets
    // their own password — nothing is stored until then.
    if (action === "invite") {
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
        firstName: String(body.firstName ?? "").trim().slice(0, 64),
        lastName: String(body.lastName ?? "").trim().slice(0, 64),
        role,
        sites: String(body.sites ?? "")
          .split(",")
          .map((site) => site.trim())
          .filter(Boolean),
        timezone: /^[A-Za-z0-9_+\-/]{1,64}$/.test(String(body.timezone ?? "")) ? String(body.timezone) : "UTC",
        invitedBy: session.user.username,
      });
      const proto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim() || request.nextUrl.protocol.replace(":", "");
      const host = request.headers.get("x-forwarded-host")?.split(",")[0].trim() || request.headers.get("host") || request.nextUrl.host;
      return ok({ inviteUrl: `${proto}://${host}/invite/${token}` });
    }

    // The UI speaks panel roles; CloudPanel only stores its three native
    // roles. Translate before the CLI/bridge call and keep the local overlay
    // (which marks panel admins) in sync with the outcome.
    let panelRole: PanelRole | undefined;
    if (action === "add" || action === "update") {
      panelRole = PANEL_ROLES.find((role) => role === String(body.role ?? ""));
      if (!panelRole)
        throw new AppError("INVALID_REQUEST", "Unknown role.", 400);
      body.role = cloudRoleFor(panelRole);
    }
    await getCloudPanelClient().manageUser(session.record.cloudPanel, body);
    if (panelRole) await setPanelAdmin(username, panelRole === "admin");
    if (action === "delete") await setPanelAdmin(username, false);
    return ok({});
  } catch (error) {
    return fail(error);
  }
}
