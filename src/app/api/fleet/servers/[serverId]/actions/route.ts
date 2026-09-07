import type { NextRequest } from "next/server";
import { z } from "zod";
import { panelActorFromSession } from "@/server/auth/site-access";
import { requireFleetSuperAdmin } from "@/server/fleet/auth";
import { dispatchFleetAction } from "@/server/fleet/service";
import { FLEET_ACTION_NAMES } from "@/server/fleet/types";
import { fail, ok } from "@/server/http";
import { assertWriteRequest, rateLimit } from "@/server/security/request";

const schema = z
  .object({ action: z.enum(FLEET_ACTION_NAMES), input: z.unknown().optional() })
  .strict();
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ serverId: string }> },
) {
  try {
    assertWriteRequest(request);
    const session = await requireFleetSuperAdmin();
    rateLimit(`fleet-action:${session.user.id}`, 240, 60_000);
    const body = schema.parse(await request.json());
    return ok(
      await dispatchFleetAction(
        (await params).serverId,
        body.action,
        body.input,
        panelActorFromSession(session),
      ),
    );
  } catch (error) {
    return fail(error);
  }
}
