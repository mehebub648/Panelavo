import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { getDeployHooks, setDeployHooks } from "@/server/deploy/hooks";
import { fail, ok } from "@/server/http";
import { audit } from "@/server/security/log";
import { assertWriteRequest, rateLimit } from "@/server/security/request";
import { isPanelAdmin } from "@/server/auth/panel-roles";
import { AppError } from "@/server/cloudpanel/errors";

async function siteWriter(domain: string) {
  const session = await requireUser();
  if (
    !session.user.canCreateSites &&
    !(await isPanelAdmin(session.user.username))
  )
    throw new AppError(
      "FORBIDDEN",
      "You do not have permission to configure deployments.",
      403,
    );
  const sites = await getCloudPanelClient().listSites(
    session.record.cloudPanel,
  );
  if (!sites.some((site) => site.domain === domain))
    throw new AppError("SITE_NOT_FOUND", "Website not found.", 404);
  return session;
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
