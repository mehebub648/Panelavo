import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/require-user";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";
import {
  createMcpPersonalToken,
  listMcpConnections,
  revokeMcpConnection,
} from "@/server/mcp/oauth";
import { getMcpPublicUrls } from "@/server/mcp/public-url";
import { audit } from "@/server/security/log";
import { assertWriteRequest, rateLimit } from "@/server/security/request";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365)]),
});

export async function POST(request: NextRequest) {
  try {
    assertWriteRequest(request);
    const session = await requireUser({ allowDuringUpdate: true });
    rateLimit(`profile:mcp-token:${session.user.id}`, 10, 60_000);
    const created = await createMcpPersonalToken(
      session.user.id,
      session.user.username,
      createSchema.parse(await request.json()),
      getMcpPublicUrls(request),
    );
    await audit("profile.mcp_token.created", "success", {
      actor: session.user,
      target: { type: "mcp-connection", id: created.connection.id },
      details: { expiresAt: created.connection.expiresAt },
    });
    return ok(created, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}

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
