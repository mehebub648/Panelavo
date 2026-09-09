import type { NextRequest } from "next/server";
import { authenticateApiToken } from "@/server/auth/api-tokens";
import { getDeployment } from "@/server/deploy/deployments";
import { fail, ok } from "@/server/http";
import { rateLimit } from "@/server/security/request";
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ domain: string; id: string }> },
) {
  try {
    const paramsValue = await params;
    const domain = decodeURIComponent(paramsValue.domain);
    const token = await authenticateApiToken(
      request,
      "deployments:write",
      domain,
    );
    rateLimit(`deployment-api:${token.id}`, 120, 60_000);
    return ok(
      await getDeployment(
        {
          user: token.user,
          cloudPanel: token.cloudPanel,
          authentication: "api-token",
          credentialId: token.id,
        },
        domain,
        paramsValue.id,
      ),
    );
  } catch (error) {
    return fail(error);
  }
}
