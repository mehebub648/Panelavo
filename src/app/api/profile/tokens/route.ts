import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from "@/server/auth/api-tokens";
import { requireUser } from "@/server/auth/require-user";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";
import { audit } from "@/server/security/log";
import { assertWriteRequest, rateLimit } from "@/server/security/request";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z
    .array(z.enum(["sites:read", "sites:write"]))
    .min(1)
    .max(2),
  expiresInDays: z
    .union([z.literal(30), z.literal(90), z.literal(365)])
    .optional(),
});

export async function GET() {
  try {
    const session = await requireUser();
    return ok(await listApiTokens(session.user.username));
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertWriteRequest(request);
    const session = await requireUser();
    rateLimit(`profile:tokens:${session.user.id}`, 10, 60_000);
    const created = await createApiToken(
      session.user.username,
      createSchema.parse(await request.json()),
    );
    await audit("profile.api_token.created", "success", {
      actor: session.user,
      target: { type: "api-token", id: created.record.id },
      details: { scopes: created.record.scopes },
    });
    return ok(created, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    assertWriteRequest(request);
    const session = await requireUser();
    const id = String(((await request.json()) as { id?: unknown }).id ?? "");
    if (!/^[0-9a-f-]{36}$/.test(id))
      throw new AppError("INVALID_REQUEST", "Choose a valid token.", 400);
    await revokeApiToken(session.user.username, id);
    await audit("profile.api_token.revoked", "success", {
      actor: session.user,
      target: { type: "api-token", id },
    });
    return ok(await listApiTokens(session.user.username));
  } catch (error) {
    return fail(error);
  }
}
