import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import {
  listUserSessions,
  revokeOtherUserSessions,
  revokeUserSession,
} from "@/server/auth/session";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";
import { audit } from "@/server/security/log";
import { assertWriteRequest, rateLimit } from "@/server/security/request";

export async function GET() {
  try {
    const session = await requireUser({ allowDuringUpdate: true });
    return ok(await listUserSessions(session.user.username, session.id));
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    assertWriteRequest(request);
    const session = await requireUser({ allowDuringUpdate: true });
    rateLimit(`profile:sessions:${session.user.id}`, 20, 60_000);
    const body = (await request.json()) as { id?: unknown; all?: unknown };
    if (body.all === true) {
      await revokeOtherUserSessions(session.user.username, session.id);
      await audit("profile.sessions.revoked_others", "success", {
        actor: session.user,
      });
    } else {
      const id = String(body.id ?? "");
      if (!/^[A-Za-z0-9_-]{40,64}$/.test(id))
        throw new AppError("INVALID_REQUEST", "Choose a valid session.", 400);
      await revokeUserSession(session.user.username, id, session.id);
      await audit("profile.session.revoked", "success", {
        actor: session.user,
        target: { type: "session", id },
      });
    }
    return ok(await listUserSessions(session.user.username, session.id));
  } catch (error) {
    return fail(error);
  }
}
