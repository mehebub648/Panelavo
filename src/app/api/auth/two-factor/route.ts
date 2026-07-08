import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { twoFactorSchema } from "@/schemas/auth";
import { getSession, updateSession } from "@/server/auth/session";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";
import { audit } from "@/server/security/log";
import {
  assertWriteRequest,
  clientKey,
  rateLimit,
} from "@/server/security/request";

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  try {
    assertWriteRequest(request);
    rateLimit(`mfa:${clientKey(request)}`, 8, 10 * 60_000);
    const pending = await getSession({ allowPending: true });
    if (!pending?.record.twoFactorPending)
      throw new AppError(
        "SESSION_EXPIRED",
        "The verification challenge has expired.",
        401,
      );
    const input = twoFactorSchema.parse(await request.json());
    const result = await getCloudPanelClient().verifyTwoFactor({
      session: pending.record.cloudPanel,
      code: input.code,
    });
    if (result.status !== "authenticated")
      throw new AppError(
        "INVALID_TWO_FACTOR_CODE",
        "That verification code is not valid.",
        401,
      );
    await updateSession(pending.id, {
      cloudPanel: result.session,
      user: result.user,
      twoFactorPending: false,
    });
    audit("authentication.two_factor", "success", {
      requestId,
      user: result.user.username,
    });
    return ok({ status: "authenticated", user: result.user });
  } catch (error) {
    audit("authentication.two_factor", "failure", { requestId });
    return fail(error);
  }
}
