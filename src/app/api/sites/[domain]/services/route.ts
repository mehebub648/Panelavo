import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { panelActorFromSession } from "@/server/auth/site-access";
import { fail, ok } from "@/server/http";
import { getRequestServerPublicIp } from "@/server/network/server-ip";
import { audit } from "@/server/security/log";
import { assertWriteRequest, rateLimit } from "@/server/security/request";
import {
  createLinkedServiceForActor,
  listLinkedServicesForActor,
} from "@/server/sites/linked-service-service";

type Context = { params: Promise<{ domain: string }> };

export async function GET(_request: NextRequest, context: Context) {
  const requestId = randomUUID();
  try {
    const parentDomain = decodeURIComponent(
      (await context.params).domain,
    ).toLowerCase();
    const session = await requireUser();
    return ok(
      await listLinkedServicesForActor(
        panelActorFromSession(session),
        parentDomain,
      ),
    );
  } catch (error) {
    audit("sites.services.list", "failure", { requestId });
    return fail(error);
  }
}

export async function POST(request: NextRequest, context: Context) {
  const requestId = randomUUID();
  try {
    assertWriteRequest(request);
    const parentDomain = decodeURIComponent(
      (await context.params).domain,
    ).toLowerCase();
    const session = await requireUser();
    const result = await createLinkedServiceForActor(
      panelActorFromSession(session),
      parentDomain,
      await request.json(),
      {
        serverIp: await getRequestServerPublicIp(request),
        onAuthorized: () =>
          rateLimit(`site-create:${session.user.id}`, 5, 10 * 60_000),
        onPrepared: (details) =>
          audit("sites.services.create.request", "success", {
            requestId,
            user: session.user.username,
            ...details,
          }),
      },
    );
    audit("sites.services.create", "success", {
      requestId,
      user: session.user.username,
      ...result.prepared,
    });
    return ok(
      { site: result.site, warnings: result.warnings },
      { status: 201 },
    );
  } catch (error) {
    audit("sites.services.create", "failure", { requestId });
    return fail(error);
  }
}
