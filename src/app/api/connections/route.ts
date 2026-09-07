import type { NextRequest } from "next/server";
import { requireFleetSuperAdmin } from "@/server/fleet/auth";
import { panelActorFromSession } from "@/server/auth/site-access";
import {
  listServerConnections,
  manageServerConnections,
} from "@/server/fleet/connections";
import { getMcpPublicUrls } from "@/server/mcp/public-url";
import { assertWriteRequest, rateLimit } from "@/server/security/request";
import { fail, ok } from "@/server/http";

export async function GET() {
  try {
    await requireFleetSuperAdmin({ allowDuringUpdate: true });
    return ok(await listServerConnections());
  } catch (error) {
    return fail(error);
  }
}
export async function POST(request: NextRequest) {
  try {
    assertWriteRequest(request);
    const session = await requireFleetSuperAdmin();
    rateLimit(`server-connections:${session.user.id}`, 20, 60_000);
    return ok(
      await manageServerConnections(
        panelActorFromSession(session),
        await request.json(),
        getMcpPublicUrls(request).origin,
      ),
    );
  } catch (error) {
    return fail(error);
  }
}
