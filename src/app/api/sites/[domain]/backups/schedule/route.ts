import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { panelActorFromSession } from "@/server/auth/site-access";
import { fail, ok } from "@/server/http";
import { assertWriteRequest } from "@/server/security/request";
import {
  getSiteBackupAutomationForActor,
  saveSiteBackupScheduleForActor,
} from "@/server/sites/site-automation-service";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
) {
  try {
    const session = await requireUser();
    const data = await getSiteBackupAutomationForActor(
      panelActorFromSession(session),
      decodeURIComponent((await params).domain),
    );
    return ok(data.schedule);
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
) {
  try {
    assertWriteRequest(request);
    const domain = decodeURIComponent((await params).domain);
    const session = await requireUser();
    return ok(
      await saveSiteBackupScheduleForActor(
        panelActorFromSession(session),
        domain,
        await request.json(),
      ),
    );
  } catch (error) {
    return fail(error);
  }
}
