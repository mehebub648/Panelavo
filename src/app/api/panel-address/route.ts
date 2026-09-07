import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireFleetSuperAdmin } from "@/server/fleet/auth";
import { changePanelAddress } from "@/server/fleet/address";
import { panelActorFromSession } from "@/server/auth/site-access";
import { getPanelAddressState } from "@/server/settings/panel-address-store";
import { getMcpPublicUrls } from "@/server/mcp/public-url";
import { fail, ok } from "@/server/http";
import { assertWriteRequest, rateLimit } from "@/server/security/request";
import { parseFleetOrigin } from "@/server/fleet/network";

export const maxDuration = 300;
export async function GET(request: NextRequest) {
  try {
    await requireFleetSuperAdmin();
    const state = getPanelAddressState();
    return ok({
      origin: getMcpPublicUrls(request).origin,
      pendingOrigin: state.pending?.origin,
    });
  } catch (error) {
    return fail(error);
  }
}
export async function POST(request: NextRequest) {
  try {
    assertWriteRequest(request);
    const session = await requireFleetSuperAdmin();
    rateLimit(`panel-address:${session.user.id}`, 10, 60_000);
    const input = z
      .object({
        origin: z.string().max(300).transform(parseFleetOrigin),
        confirmation: z.string().max(253),
      })
      .strict()
      .refine(
        (value) => value.confirmation === new URL(value.origin).hostname,
        "Type the new hostname exactly to confirm.",
      )
      .parse(await request.json());
    return ok(
      await changePanelAddress(
        input.origin,
        getMcpPublicUrls(request).origin,
        panelActorFromSession(session),
      ),
    );
  } catch (error) {
    return fail(error);
  }
}
