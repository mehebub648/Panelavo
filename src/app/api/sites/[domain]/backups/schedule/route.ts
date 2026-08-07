import type { NextRequest } from "next/server";
import { backupScheduleSchema, getBackupSchedule, saveBackupSchedule } from "@/server/backups/schedule";
import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";
import { assertWriteRequest } from "@/server/security/request";

async function authorizedDomain(encodedDomain: string) {
  const session = await requireUser();
  const domain = decodeURIComponent(encodedDomain);
  await getCloudPanelClient().getSiteSection(
    session.record.cloudPanel,
    domain,
    "backups",
  );
  return { session, domain };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
) {
  try {
    const { domain } = await authorizedDomain((await params).domain);
    return ok(await getBackupSchedule(domain));
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
    const { session, domain } = await authorizedDomain((await params).domain);
    if (!(session.user.canCreateSites || session.user.panelRole === "admin"))
      throw new AppError(
        "FORBIDDEN",
        "You do not have permission to change this schedule.",
        403,
      );
    return ok(
      await saveBackupSchedule(
        domain,
        backupScheduleSchema.parse(await request.json()),
      ),
    );
  } catch (error) {
    return fail(error);
  }
}
