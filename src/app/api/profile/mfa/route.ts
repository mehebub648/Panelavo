import type { NextRequest } from "next/server";
import QRCode from "qrcode";
import { requireUser } from "@/server/auth/require-user";
import { updateSession } from "@/server/auth/session";
import {
  beginMfaEnrollment,
  clearMfaEnrollment,
  getMfaEnrollment,
} from "@/server/auth/mfa-enrollment";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { ok, fail } from "@/server/http";
import { assertWriteRequest, rateLimit } from "@/server/security/request";
import { audit } from "@/server/security/log";
import { revokeAllMcpConnections } from "@/server/mcp/oauth";

export async function POST(request: NextRequest) {
  let username: string | undefined;
  let action = "unknown";
  try {
    assertWriteRequest(request);
    const session = await requireUser({ allowDuringUpdate: true });
    username = session.user.username;
    rateLimit(`profile:mfa:${session.user.id}`, 8, 60_000);
    const body = (await request.json()) as Record<string, unknown>;
    action = String(body.action ?? "");
    const client = getCloudPanelClient();
    if (action === "start") {
      if (session.user.mfa)
        throw new AppError(
          "INVALID_REQUEST",
          "Two-factor authentication is already enabled.",
          409,
        );
      await client.verifyPassword(
        session.record.cloudPanel,
        String(body.currentPassword ?? ""),
      );
      const secret = await beginMfaEnrollment(username);
      const label = `Panelavo:${username}`;
      const uri = `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent("Panelavo")}&algorithm=SHA1&digits=6&period=30`;
      const qrCode = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
      await audit("profile.mfa.enrollment_started", "success", {
        actor: session.user,
      });
      return ok({ secret, uri, qrCode, expiresInSeconds: 600 });
    }
    if (action === "enable") {
      const secret = await getMfaEnrollment(username);
      if (!secret)
        throw new AppError(
          "INVALID_REQUEST",
          "The enrollment expired. Start again.",
          410,
        );
      const user = await client.manageMfa(session.record.cloudPanel, {
        action: "enable",
        secret,
        code: String(body.code ?? ""),
      });
      await clearMfaEnrollment(username);
      await updateSession(session.id, { user });
      await revokeAllMcpConnections(user.id, user.username);
      await audit("profile.mfa.enabled", "success", { actor: user });
      return ok({ user });
    }
    if (action === "disable") {
      const user = await client.manageMfa(session.record.cloudPanel, {
        action: "disable",
        code: String(body.code ?? ""),
      });
      await clearMfaEnrollment(username);
      await updateSession(session.id, { user });
      await revokeAllMcpConnections(user.id, user.username);
      await audit("profile.mfa.disabled", "success", { actor: user });
      return ok({ user });
    }
    throw new AppError("INVALID_REQUEST", "Unknown MFA action.", 400);
  } catch (error) {
    await audit(`profile.mfa.${action}`, "failure", {
      actor: username,
      error,
    });
    return fail(error);
  }
}
