import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { panelActorFromSession } from "@/server/auth/site-access";
import { fail, ok } from "@/server/http";
import { assertWriteRequest } from "@/server/security/request";
import {
  getSiteUptimeForActor,
  saveSiteUptimeForActor,
} from "@/server/sites/site-automation-service";

type Context = { params: Promise<{ domain: string }> };

export async function GET(_request: NextRequest, { params }: Context) {
  try {
    const session = await requireUser();
    return ok(
      await getSiteUptimeForActor(
        panelActorFromSession(session),
        decodeURIComponent((await params).domain),
      ),
    );
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(request: NextRequest, { params }: Context) {
  try {
    assertWriteRequest(request);
    const session = await requireUser();
    return ok(
      await saveSiteUptimeForActor(
        panelActorFromSession(session),
        decodeURIComponent((await params).domain),
        await request.json(),
      ),
    );
  } catch (error) {
    return fail(error);
  }
}
