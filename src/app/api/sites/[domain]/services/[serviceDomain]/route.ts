import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { panelActorFromSession } from "@/server/auth/site-access";
import { fail, ok } from "@/server/http";
import { getRequestServerPublicIp } from "@/server/network/server-ip";
import { audit } from "@/server/security/log";
import { assertWriteRequest, rateLimit } from "@/server/security/request";
import {
  deleteProjectEndpointForActor,
  updateProjectEndpointForActor,
  verifyProjectEndpointForActor,
} from "@/server/sites/linked-service-service";

type Context = {
  params: Promise<{ domain: string; serviceDomain: string }>;
};

async function requestContext(context: Context) {
  const params = await context.params;
  return {
    parentDomain: decodeURIComponent(params.domain).toLowerCase(),
    endpointDomain: decodeURIComponent(params.serviceDomain).toLowerCase(),
  };
}

export async function POST(request: NextRequest, context: Context) {
  const requestId = randomUUID();
  try {
    assertWriteRequest(request);
    const { parentDomain, endpointDomain } = await requestContext(context);
    const session = await requireUser();
    rateLimit(`site-endpoint-verify:${session.user.id}`, 20, 10 * 60_000);
    const result = await verifyProjectEndpointForActor(
      panelActorFromSession(session),
      parentDomain,
      endpointDomain,
      { serverIp: await getRequestServerPublicIp(request) },
    );
    audit("sites.endpoints.verify", "success", {
      requestId,
      user: session.user.username,
      parentDomain,
      endpointDomain,
      verified: result.verified,
      activated: result.activated,
    });
    return ok(result);
  } catch (error) {
    audit("sites.endpoints.verify", "failure", { requestId });
    return fail(error);
  }
}

export async function PATCH(request: NextRequest, context: Context) {
  const requestId = randomUUID();
  try {
    assertWriteRequest(request);
    const { parentDomain, endpointDomain } = await requestContext(context);
    const session = await requireUser();
    rateLimit(`site-endpoint-update:${session.user.id}`, 20, 10 * 60_000);
    const result = await updateProjectEndpointForActor(
      panelActorFromSession(session),
      parentDomain,
      endpointDomain,
      await request.json(),
    );
    audit("sites.endpoints.update", "success", {
      requestId,
      user: session.user.username,
      parentDomain,
      endpointDomain,
      targetPort: result.endpoint.targetPort,
      pending: result.pending,
    });
    return ok(result);
  } catch (error) {
    audit("sites.endpoints.update", "failure", { requestId });
    return fail(error);
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  const requestId = randomUUID();
  try {
    assertWriteRequest(request);
    const { parentDomain, endpointDomain } = await requestContext(context);
    const session = await requireUser();
    rateLimit(`site-endpoint-delete:${session.user.id}`, 10, 10 * 60_000);
    const result = await deleteProjectEndpointForActor(
      panelActorFromSession(session),
      parentDomain,
      endpointDomain,
    );
    audit("sites.endpoints.delete", "success", {
      requestId,
      user: session.user.username,
      parentDomain,
      endpointDomain,
    });
    return ok(result);
  } catch (error) {
    audit("sites.endpoints.delete", "failure", { requestId });
    return fail(error);
  }
}
