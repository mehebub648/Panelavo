import type { NextRequest } from "next/server";
import { z } from "zod";
import { panelActorFromSession } from "@/server/auth/site-access";
import { requireFleetSuperAdmin } from "@/server/fleet/auth";
import {
  resumeFleetRollingUpdates,
  startFleetRollingUpdate,
} from "@/server/fleet/service";
import { fail, ok } from "@/server/http";
import { assertWriteRequest, rateLimit } from "@/server/security/request";

const schema = z
  .object({
    serverIds: z.array(z.string().uuid()).min(1).max(100),
    confirmation: z.literal("ROLLING UPDATE"),
  })
  .strict();

export async function GET() {
  try {
    await requireFleetSuperAdmin({ allowDuringUpdate: true });
    return ok(await resumeFleetRollingUpdates());
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertWriteRequest(request);
    const session = await requireFleetSuperAdmin();
    rateLimit(`fleet-rolling-update:${session.user.id}`, 5, 60_000);
    const input = schema.parse(await request.json());
    return ok(
      await startFleetRollingUpdate(
        input.serverIds,
        panelActorFromSession(session),
      ),
      { status: 202 },
    );
  } catch (error) {
    return fail(error);
  }
}
