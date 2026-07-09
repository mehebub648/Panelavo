import type { NextRequest } from "next/server";
import type { CloudPanelSession } from "@/types/cloudpanel";
import { verifyInviteToken } from "@/server/auth/invites";
import { cloudRoleFor, setPanelAdmin } from "@/server/auth/panel-roles";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { audit } from "@/server/security/log";
import { assertWriteRequest, rateLimit } from "@/server/security/request";
import { fail, ok } from "@/server/http";

// Redeems an invitation link: the invitee chooses a password and the account
// is created with exactly the access the issuing super admin signed into the
// token. The creation runs under the issuer's authority (their username is
// part of the signed payload), so a revoked or demoted issuer voids the link.
export async function POST(request: NextRequest) {
  try {
    assertWriteRequest(request);
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
    rateLimit(`invite:${ip}`, 5, 10 * 60_000);
    const body = (await request.json()) as Record<string, unknown>;
    const payload = verifyInviteToken(String(body.token ?? ""));
    if (!payload)
      throw new AppError(
        "INVALID_REQUEST",
        "This invitation link is invalid or has expired.",
        400,
      );
    const password = String(body.password ?? "");
    if (
      password.length < 12 ||
      password.length > 128 ||
      /[\x00-\x1f\x7f]/.test(password)
    )
      throw new AppError(
        "INVALID_REQUEST",
        "Use a password of at least 12 characters.",
        400,
      );

    const issuerSession: CloudPanelSession = {
      cookies: {},
      usernameHint: payload.invitedBy,
      cliAuthenticated: true,
    };
    const client = getCloudPanelClient();
    const issuer = await client.getCurrentUser(issuerSession).catch(() => null);
    if (issuer?.panelRole !== "super-admin")
      throw new AppError(
        "INVALID_REQUEST",
        "This invitation is no longer valid.",
        400,
      );

    await client.manageUser(issuerSession, {
      action: "add",
      username: payload.username,
      email: payload.email,
      firstName: payload.firstName,
      lastName: payload.lastName,
      password,
      role: cloudRoleFor(payload.role),
      sites: payload.sites.join(","),
      timezone: payload.timezone,
    });
    await setPanelAdmin(payload.username, payload.role === "admin");
    audit("users.invite.redeem", "success", {
      username: payload.username,
      invitedBy: payload.invitedBy,
    });
    return ok({ username: payload.username });
  } catch (error) {
    audit("users.invite.redeem", "failure", {});
    return fail(error);
  }
}
