import type { NextRequest } from "next/server";
import type { PanelRole } from "@/types/cloudpanel";
import { requireUser } from "@/server/auth/require-user";
import { cloudRoleFor, setPanelAdmin } from "@/server/auth/panel-roles";
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
