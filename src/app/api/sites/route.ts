import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { createSiteSchema } from "@/schemas/sites";
import { fail, ok } from "@/server/http";
import { audit } from "@/server/security/log";
import { assertWriteRequest, rateLimit } from "@/server/security/request";

export async function GET() {
  const requestId = randomUUID();
  try {
    const session = await requireUser();
    const sites = await getCloudPanelClient().listSites(
      session.record.cloudPanel,
    );
    return ok({ sites });
  } catch (error) {
    audit("sites.list", "failure", { requestId });
    return fail(error);
  }
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  try {
    assertWriteRequest(request);
    const session = await requireUser();
    rateLimit(`site-create:${session.user.id}`, 5, 10 * 60_000);
    if (!session.user.canCreateSites)
      return fail(
        new (await import("@/server/cloudpanel/errors")).AppError(
          "FORBIDDEN",
          "You do not have permission to create websites.",
          403,
        ),
      );
    const input = createSiteSchema.parse(await request.json());
    audit("sites.create.request", "success", {
      requestId,
      user: session.user.username,
      siteType: input.type,
      domain: input.domain,
    });
    const site = await getCloudPanelClient().createSite(
      session.record.cloudPanel,
      input,
    );
    audit("sites.create", "success", {
      requestId,
      user: session.user.username,
      siteType: input.type,
      domain: input.domain,
    });
    return ok({ site }, { status: 201 });
  } catch (error) {
    audit("sites.create", "failure", { requestId });
    return fail(error);
  }
}
