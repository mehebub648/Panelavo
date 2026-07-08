import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { assertWriteRequest } from "@/server/security/request";
import { fail, ok } from "@/server/http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ domain: string; section: string }> },
) {
  try {
    assertWriteRequest(request);
    const session = await requireUser();
    const { domain, section } = await params;
    const data = await getCloudPanelClient().manageSiteSection(
      session.record.cloudPanel,
      decodeURIComponent(domain),
      section,
      await request.json(),
    );
    return ok(data);
  } catch (error) {
    return fail(error);
  }
}
