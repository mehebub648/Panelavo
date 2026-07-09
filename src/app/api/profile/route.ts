import type { NextRequest } from "next/server";
import type { UpdateProfileInput } from "@/types/cloudpanel";
import { requireUser } from "@/server/auth/require-user";
import { updateSession } from "@/server/auth/session";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { assertWriteRequest, rateLimit } from "@/server/security/request";
import { fail, ok } from "@/server/http";

export async function POST(request: NextRequest) {
  try {
    assertWriteRequest(request);
    const session = await requireUser();
    rateLimit(`profile:${session.user.id}`, 10, 60_000);
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action ?? "");
    let input: UpdateProfileInput;
    if (action === "change-password") {
      const newPassword = String(body.newPassword ?? "");
      if (newPassword.length < 12 || newPassword.length > 128 || /[\x00-\x1f\x7f]/.test(newPassword))
        throw new AppError("INVALID_REQUEST", "Use a password of at least 12 characters.", 400);
      input = {
        action: "change-password",
        currentPassword: String(body.currentPassword ?? ""),
        newPassword,
      };
    } else if (action === "update") {
      input = {
        action: "update",
        firstName: body.firstName === undefined ? undefined : String(body.firstName).trim().slice(0, 64),
        lastName: body.lastName === undefined ? undefined : String(body.lastName).trim().slice(0, 64),
        email: body.email === undefined ? undefined : String(body.email).trim(),
        timezone: body.timezone === undefined ? undefined : String(body.timezone),
      };
      if (input.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email))
        throw new AppError("INVALID_REQUEST", "Enter a valid email address.", 400);
      if (input.timezone !== undefined && !/^[A-Za-z0-9_+\-/]{1,64}$/.test(input.timezone))
        throw new AppError("INVALID_REQUEST", "Unknown timezone.", 400);
    } else {
      throw new AppError("INVALID_REQUEST", "Unknown profile action.", 400);
    }
    const user = await getCloudPanelClient().updateProfile(session.record.cloudPanel, input);
    await updateSession(session.id, { user });
    return ok({ user });
  } catch (error) {
    return fail(error);
  }
}
