import type { NextRequest } from "next/server";
import { backupScheduleSchema, getBackupSchedule, saveBackupSchedule } from "@/server/backups/schedule";
import { fail, ok } from "@/server/http";
import { assertWriteRequest } from "@/server/security/request";
import {
  requireAccessibleSite,
  requireWritableSite,
} from "@/server/auth/site-access";

async function authorizedDomain(encodedDomain: string) {
  const domain = decodeURIComponent(encodedDomain);
  return { ...(await requireAccessibleSite(domain)), domain };
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
    const domain = decodeURIComponent((await params).domain);
    await requireWritableSite(domain);
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
