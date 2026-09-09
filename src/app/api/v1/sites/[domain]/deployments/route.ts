import type { NextRequest } from "next/server";
import { authenticateApiToken } from "@/server/auth/api-tokens";
import { listDeployments, startDeployment } from "@/server/deploy/deployments";
import { ciDeploymentRequestSchema } from "@/lib/deployment";
import { fail, ok } from "@/server/http";
import { rateLimit } from "@/server/security/request";
import { audit } from "@/server/security/log";
async function deploymentActor(request: NextRequest, domain: string) {
  const token = await authenticateApiToken(
    request,
    "deployments:write",
    domain,
  );
  rateLimit(`deployment-api:${token.id}`, 120, 60_000);
  return {
    user: token.user,
    cloudPanel: token.cloudPanel,
    authentication: "api-token" as const,
    credentialId: token.id,
  };
}
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
) {
  try {
    const domain = decodeURIComponent((await params).domain);
    return ok(
      await listDeployments(await deploymentActor(request, domain), domain),
    );
  } catch (error) {
    return fail(error);
  }
}
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
) {
  try {
    const domain = decodeURIComponent((await params).domain);
    const actor = await deploymentActor(request, domain);
    const input = ciDeploymentRequestSchema.parse(await request.json());
    const job = await startDeployment(
      actor,
      domain,
      input,
      request.headers.get("idempotency-key"),
    );
    await audit("api.deployment.queued", "success", {
      actor: actor.user,
      target: { type: "site", id: domain },
      details: { jobId: job.id, commit: input.expectedCommit },
    });
    return ok(job, { status: 202 });
  } catch (error) {
    return fail(error);
  }
}
