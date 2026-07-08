import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { destroySession, getSession } from "@/server/auth/session";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { fail, ok } from "@/server/http";
import { audit } from "@/server/security/log";
import { assertWriteRequest } from "@/server/security/request";

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  try {
    assertWriteRequest(request);
    const session = await getSession({ allowPending: true });
    if (session) await getCloudPanelClient().logout(session.record.cloudPanel);
    await destroySession();
    audit("authentication.logout", "success", {
      requestId,
      user: session?.record.user?.username,
    });
    return ok({ loggedOut: true });
  } catch (error) {
    await destroySession();
    audit("authentication.logout", "failure", { requestId });
    return fail(error);
  }
}
