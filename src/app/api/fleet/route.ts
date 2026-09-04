import type { NextRequest } from "next/server";
import { z } from "zod";
import { panelActorFromSession } from "@/server/auth/site-access";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { requireFleetSuperAdmin } from "@/server/fleet/auth";
import {
  connectToFleetHub,
  createFleetInvitation,
  disconnectFleet,
  disconnectFleetNodeFromHub,
  disconnectNodeFromHub,
  enableFleetHub,
  getFleetPublicState,
  parseFleetInvitation,
  rotateFleetConnection,
} from "@/server/fleet/service";
import { fail, ok } from "@/server/http";
import { getMcpPublicUrls } from "@/server/mcp/public-url";
import { assertWriteRequest, rateLimit } from "@/server/security/request";

const schema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("enable-hub"),
      label: z.string().trim().max(100),
      currentPassword: z.string().min(1).max(256),
      confirmation: z.literal("ENABLE FLEET HUB"),
    })
    .strict(),
  z.object({ action: z.literal("create-invitation") }).strict(),
  z
    .object({
      action: z.literal("connect"),
      invitation: z.string().min(40).max(4096),
      currentPassword: z.string().min(1).max(256),
      confirmation: z.string().min(1).max(253),
    })
    .strict(),
  z
    .object({
      action: z.literal("disconnect-node"),
      serverId: z.string().uuid(),
      confirmation: z.string(),
    })
    .strict(),
  z
    .object({
      action: z.literal("disconnect-hub"),
      confirmation: z.literal("DISCONNECT FLEET"),
    })
    .strict(),
  z
    .object({
      action: z.literal("disable-hub"),
      confirmation: z.literal("DISABLE FLEET HUB"),
    })
    .strict(),
  z
    .object({
      action: z.literal("rotate-key"),
      serverId: z.string().uuid(),
      confirmation: z.literal("ROTATE FLEET KEY"),
    })
    .strict(),
]);

export async function GET() {
  try {
    await requireFleetSuperAdmin({ allowDuringUpdate: true });
    return ok(await getFleetPublicState());
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertWriteRequest(request);
    const session = await requireFleetSuperAdmin();
    rateLimit(`fleet-config:${session.user.id}`, 30, 60_000);
    const actor = panelActorFromSession(session);
    const input = schema.parse(await request.json());
    if (input.action === "enable-hub") {
      await getCloudPanelClient().verifyPassword(
        session.record.cloudPanel,
        input.currentPassword,
      );
      return ok(
        await enableFleetHub(input.label, getMcpPublicUrls(request).origin),
      );
    }
    if (input.action === "create-invitation")
      return ok(
        await createFleetInvitation({
          id: session.user.id,
          username: session.user.username,
        }),
      );
    if (input.action === "connect") {
      const invitation = parseFleetInvitation(input.invitation);
      if (
        input.confirmation.toLowerCase() !==
        new URL(invitation.hubOrigin).hostname.toLowerCase()
      )
        throw new AppError(
          "INVALID_REQUEST",
          "Type the Fleet Hub hostname exactly.",
          400,
        );
      await getCloudPanelClient().verifyPassword(
        session.record.cloudPanel,
        input.currentPassword,
      );
      return ok(
        await connectToFleetHub(
          actor,
          input.invitation,
          getMcpPublicUrls(request).origin,
        ),
      );
    }
    if (input.action === "disconnect-node") {
      const state = await getFleetPublicState();
      const node = state.nodes.find((item) => item.id === input.serverId);
      if (!node || input.confirmation !== node.node.label)
        throw new AppError(
          "INVALID_REQUEST",
          "Type the Node label exactly.",
          400,
        );
      return ok(await disconnectFleetNodeFromHub(input.serverId, actor));
    }
    if (input.action === "disconnect-hub")
      return ok(await disconnectNodeFromHub(actor));
    if (input.action === "disable-hub") {
      await disconnectFleet();
      return ok(await getFleetPublicState());
    }
    return ok(await rotateFleetConnection(input.serverId, actor));
  } catch (error) {
    return fail(error);
  }
}
