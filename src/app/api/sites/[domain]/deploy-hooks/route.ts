import type { NextRequest } from "next/server";
import { getDeployHooks, setDeployHooks } from "@/server/deploy/hooks";
import { fail, ok } from "@/server/http";
import { audit } from "@/server/security/log";
import { assertWriteRequest, rateLimit } from "@/server/security/request";
import { requireWritableSite } from "@/server/auth/site-access";

async function siteWriter(domain: string) {
  return (await requireWritableSite(domain)).session;
}
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
) {
  try {
    const domain = decodeURIComponent((await params).domain);
    await siteWriter(domain);
    return ok(await getDeployHooks(domain));
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
    const session = await siteWriter(domain);
    rateLimit(`deploy-hooks:${session.user.id}`, 20, 60_000);
    const hooks = await setDeployHooks(
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
