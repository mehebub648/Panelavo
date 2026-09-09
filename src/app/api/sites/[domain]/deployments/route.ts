import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { panelActorFromSession } from "@/server/auth/site-access";
import { fail, ok } from "@/server/http";
import { assertWriteRequest, rateLimit } from "@/server/security/request";
import { audit } from "@/server/security/log";
import { listDeployments, startDeployment } from "@/server/deploy/deployments";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
) {
  try {
    const domain = decodeURIComponent((await params).domain);
    const actor = panelActorFromSession(await requireUser());
    return ok(await listDeployments(actor, domain));
  } catch (error) {
    return fail(error);
  }
}
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
) {
  try {
    assertWriteRequest(request);
    const domain = decodeURIComponent((await params).domain);
    const actor = panelActorFromSession(await requireUser());
    rateLimit(`deployment:${actor.user.id}`, 30, 60_000);
    const result = await startDeployment(
      actor,
      domain,
      await request.json(),
      request.headers.get("idempotency-key"),
    );
    await audit("site.deployments.updated", "success", {
      actor: actor.user,
      target: { type: "site", id: domain },
    });
    return ok(result, { status: 202 });
  } catch (error) {
    return fail(error);
  }
}
