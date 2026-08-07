import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/require-user";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";
import { audit } from "@/server/security/log";
import { assertWriteRequest } from "@/server/security/request";
import {
  getSecuritySettings,
  setSecuritySettings,
} from "@/server/settings/store";

const schema = z.object({
  sessionLifetimeMinutes: z.number().int().min(15).max(10_080),
  passwordMinLength: z.number().int().min(12).max(128),
  requireUppercase: z.boolean(),
  requireLowercase: z.boolean(),
  requireNumber: z.boolean(),
  requireSymbol: z.boolean(),
});

async function requireSuperAdmin() {
  const session = await requireUser();
  if (session.user.panelRole !== "super-admin")
    throw new AppError(
      "FORBIDDEN",
      "Security settings are available to super administrators only.",
      403,
    );
  return session;
}

export async function GET() {
  try {
    await requireSuperAdmin();
    return ok(await getSecuritySettings());
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    assertWriteRequest(request);
    const session = await requireSuperAdmin();
    const value = await setSecuritySettings(schema.parse(await request.json()));
    await audit("security.policy.updated", "success", { actor: session.user });
    return ok(value);
  } catch (error) {
    return fail(error);
  }
}
