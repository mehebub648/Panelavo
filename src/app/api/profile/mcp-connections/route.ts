import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";
import { listMcpConnections, revokeMcpConnection } from "@/server/mcp/oauth";
import { audit } from "@/server/security/log";
import { assertWriteRequest, rateLimit } from "@/server/security/request";

export async function DELETE(request: NextRequest) {
  try {
    assertWriteRequest(request);
    const session = await requireUser({ allowDuringUpdate: true });
    rateLimit(`profile:mcp-connections:${session.user.id}`, 20, 60_000);
    const id = String(((await request.json()) as { id?: unknown }).id ?? "");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      throw new AppError(
        "INVALID_REQUEST",
        "Choose a valid AI assistant connection.",
        400,
      );

    await revokeMcpConnection(session.user.id, session.user.username, id);
    await audit("profile.mcp_connection.revoked", "success", {
      actor: session.user,
      target: { type: "mcp-connection", id },
    });
    return ok(await listMcpConnections(session.user.id, session.user.username));
  } catch (error) {
    return fail(error);
  }
}
