import type { NextRequest } from "next/server";
import QRCode from "qrcode";
import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { ok, fail } from "@/server/http";
import { assertWriteRequest, rateLimit } from "@/server/security/request";
import { audit } from "@/server/security/log";
import { vpnManageSchema } from "@/server/vpn/schema";

async function requireSuperAdmin(allowDuringUpdate = false) {
  const session = await requireUser({ allowDuringUpdate });
  if (session.user.panelRole !== "super-admin")
    throw new AppError(
      "FORBIDDEN",
      "VPN management is available to super administrators only.",
      403,
    );
  return session;
}

export async function GET() {
  try {
    const session = await requireSuperAdmin(true);
    return ok(
      await getCloudPanelClient().getVpnState(session.record.cloudPanel),
    );
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: NextRequest) {
  let actor: string | undefined;
  let action = "unknown";
  try {
    assertWriteRequest(request);
    const session = await requireSuperAdmin();
    actor = session.user.username;
    rateLimit(`vpn:${session.user.id}`, 12, 60_000);
    const input = vpnManageSchema.parse(await request.json());
    action = input.action;
    const result = await getCloudPanelClient().manageVpn(
      session.record.cloudPanel,
      input,
    );
    if (result.provisioning) {
      try {
        result.provisioning.qrCode = await QRCode.toDataURL(
          result.provisioning.configuration,
          { margin: 1, width: 280, errorCorrectionLevel: "M" },
        );
      } catch {
        // The non-recoverable configuration must still reach the user once.
        // QR rendering is an optional convenience; download/import remains safe.
      }
    }
    await audit(`vpn.${action}`, "success", {
      actor: session.user,
      deviceId:
        "deviceId" in input ? input.deviceId : result.provisioning?.device.id,
    });
    return ok(result);
  } catch (error) {
    await audit(`vpn.${action}`, "failure", { actor, error });
    return fail(error);
  }
}
