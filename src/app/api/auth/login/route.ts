import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { loginSchema } from "@/schemas/auth";
import { createSession, destroySession } from "@/server/auth/session";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { audit } from "@/server/security/log";
import {
  assertWriteRequest,
  clientKey,
  rateLimit,
} from "@/server/security/request";
import { fail, ok } from "@/server/http";

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  try {
    assertWriteRequest(request);
    rateLimit(`login:${clientKey(request)}`, 10, 15 * 60_000);
    const input = loginSchema.parse(await request.json());
    await destroySession();
    const result = await getCloudPanelClient().login(input);
    if (result.status === "two-factor-required") {
      await createSession({
        cloudPanel: result.session,
        twoFactorPending: true,
      });
      audit("authentication.challenge", "success", {
        requestId,
        user: input.username,
      });
      return ok({ status: "two-factor-required" });
    }
    await createSession({ cloudPanel: result.session, user: result.user });
    audit("authentication.login", "success", {
      requestId,
      user: result.user.username,
    });
    return ok({ status: "authenticated", user: result.user });
  } catch (error) {
    audit("authentication.login", "failure", {
      requestId,
      errorCode: error instanceof Error ? error.name : "unknown",
    });
    return fail(error);
  }
}
