import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { panelActorFromSession } from "@/server/auth/site-access";
import { fail, ok } from "@/server/http";
import { audit } from "@/server/security/log";
import { assertWriteRequest, rateLimit } from "@/server/security/request";
import {
  getSiteDeployHooksForActor,
  saveSiteDeployHooksForActor,
} from "@/server/sites/site-automation-service";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
) {
  try {
    const domain = decodeURIComponent((await params).domain);
    const session = await requireUser();
    return ok(
      await getSiteDeployHooksForActor(panelActorFromSession(session), domain),
    );
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
    rateLimit(`deploy-hooks:${session.user.id}`, 20, 60_000);
    const hooks = await saveSiteDeployHooksForActor(
      panelActorFromSession(session),
      domain,
      ((await request.json()) as { hooks?: unknown }).hooks,
    );
    await audit("site.deploy_hooks.updated", "success", {
      actor: session.user,
      target: { type: "site", id: domain },
      details: { count: hooks.length },
    });
    return ok(hooks);
  } catch (error) {
    return fail(error);
  }
}
