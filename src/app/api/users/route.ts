import type { NextRequest } from "next/server";
import type { PanelRole } from "@/types/cloudpanel";
import { requireUser } from "@/server/auth/require-user";
import { cloudRoleFor, setPanelAdmin } from "@/server/auth/panel-roles";
import { createUserInvitation } from "@/server/auth/user-invitation";
import { panelActorFromSession } from "@/server/auth/site-access";
import { getMcpPublicUrls } from "@/server/mcp/public-url";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { assertWriteRequest, rateLimit } from "@/server/security/request";
import { fail, ok } from "@/server/http";
import { revokeAllMcpConnections } from "@/server/mcp/oauth";
import { revokeFleetAuthorizationForUser } from "@/server/fleet/service";

const PANEL_ROLES: PanelRole[] = ["super-admin", "manager", "admin", "user"];

export async function GET() {
  try {
    const session = await requireUser();
    if (session.user.panelRole !== "super-admin")
      throw new AppError(
        "FORBIDDEN",
        "Users are available to administrators only.",
        403,
      );
    return ok({
      users: await getCloudPanelClient().listUsers(session.record.cloudPanel),
    });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertWriteRequest(request);
    const session = await requireUser();
    if (session.user.panelRole !== "super-admin")
      throw new AppError(
        "FORBIDDEN",
        "Users are available to administrators only.",
        403,
      );
    rateLimit(`users:${session.user.id}`, 10, 60_000);
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action ?? "");
    const username = String(body.username ?? "").toLowerCase();

    // Passwordless onboarding: sign the whole account definition into a JWT.
    // The account is created only when the invitee opens the link and sets
    // their own password — nothing is stored until then.
    if (action === "invite")
      return ok(
        createUserInvitation(
          panelActorFromSession(session),
          body,
          getMcpPublicUrls(request).origin,
        ),
      );

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
    const client = getCloudPanelClient();
    const mutationTarget = ["update", "reset-password", "delete"].includes(
      action,
    )
      ? (await client.listUsers(session.record.cloudPanel)).find(
          (candidate) => candidate.username.toLowerCase() === username,
        )
      : undefined;
    await client.manageUser(session.record.cloudPanel, body);
    if (panelRole) await setPanelAdmin(username, panelRole === "admin");
    if (action === "delete") await setPanelAdmin(username, false);
    if (mutationTarget && ["reset-password", "delete"].includes(action))
      await revokeAllMcpConnections(mutationTarget.id, mutationTarget.username);
    if (mutationTarget) await revokeFleetAuthorizationForUser(mutationTarget);
    return ok({});
  } catch (error) {
    return fail(error);
  }
}
