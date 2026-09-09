import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { panelActorFromSession } from "@/server/auth/site-access";
import { getDeployment } from "@/server/deploy/deployments";
import { fail, ok } from "@/server/http";
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ domain: string; id: string }> },
) {
  try {
    const { domain, id } = await params;
    return ok(
      await getDeployment(
        panelActorFromSession(await requireUser()),
        decodeURIComponent(domain),
        id,
      ),
    );
  } catch (error) {
    return fail(error);
  }
}
