import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";
import { assertWriteRequest } from "@/server/security/request";
import { getPublicNotificationSettings, notificationSettingsSchema, saveNotificationSettings } from "@/server/notifications/store";
import { sendNotification } from "@/server/notifications/send";

async function requireSuperAdmin() {
  const session = await requireUser();
  if (session.user.panelRole !== "super-admin")
    throw new AppError("FORBIDDEN", "Notification settings are available to super administrators only.", 403);
}

export async function GET() {
  try { await requireSuperAdmin(); return ok(await getPublicNotificationSettings()); }
  catch (error) { return fail(error); }
}

export async function PUT(request: NextRequest) {
  try {
    assertWriteRequest(request); await requireSuperAdmin();
    return ok(await saveNotificationSettings(notificationSettingsSchema.parse(await request.json())));
  } catch (error) { return fail(error); }
}

export async function POST(request: NextRequest) {
  try {
    assertWriteRequest(request); await requireSuperAdmin();
    const result = await sendNotification({ title: "Test notification", message: "Panelavo notification delivery is configured.", severity: "info", event: "notifications.test" });
    if (!result.configured || (result.email === false || result.webhook === false))
      throw new AppError("SITE_UPDATE_FAILED", "One or more configured notification channels rejected the test.", 502);
    return ok(result);
  } catch (error) { return fail(error); }
}
