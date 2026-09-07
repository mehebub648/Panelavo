import { z } from "zod";
import type { PanelActor } from "@/server/auth/site-access";
import {
  connectToFleetHub,
  createFleetInvitation,
  enableFleetHub,
  getFleetPublicState,
  disconnectFleetNodeFromHub,
  disconnectNodeFromHub,
  renameConnectedServer,
} from "@/server/fleet/service";
import { audit, auditContext } from "@/server/security/log";
import { getPanelAddressState } from "@/server/settings/panel-address-store";
import { AppError } from "@/server/cloudpanel/errors";

const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("generate-token") }).strict(),
  z
    .object({
      action: z.literal("submit-token"),
      token: z.string().trim().min(40).max(4096),
    })
    .strict(),
  z
    .object({
      action: z.literal("rename"),
      id: z.string().uuid(),
      nickname: z.string().trim().max(100),
    })
    .strict(),
  z
    .object({
      action: z.literal("disconnect"),
      id: z.string().uuid(),
      direction: z.enum(["outgoing", "incoming"]),
      confirmation: z.literal("DISCONNECT SERVER"),
    })
    .strict(),
]);

export async function listServerConnections() {
  const state = await getFleetPublicState();
  return {
    outgoing: state.nodes.map((item) => ({
      id: item.id,
      label: item.nickname || item.node.label,
      origin: item.node.origin,
      status: item.status,
      fullAccess: true,
    })),
    incoming: state.nodeLinks.map((item) => ({
      id: item.connectionId,
      label: item.nickname || item.hubLabel,
      origin: item.hubOrigin,
      status: item.status,
      fullAccess: item.fullAdmin === true,
    })),
  };
}

export async function manageServerConnections(
  actor: PanelActor,
  submitted: unknown,
  origin: string,
) {
  if (actor.user.panelRole !== "super-admin")
    throw new AppError("FORBIDDEN", "Super Admin access is required.", 403);
  const input = inputSchema.parse(submitted);
  if (
    ["generate-token", "submit-token"].includes(input.action) &&
    getPanelAddressState().pending
  )
    throw new AppError(
      "INVALID_REQUEST",
      "Finish the pending panel address change before connecting servers.",
      409,
    );
  let result: unknown;
  if (input.action === "generate-token") {
    await enableFleetHub(new URL(origin).hostname, origin);
    const created = await createFleetInvitation({
      id: actor.user.id,
      username: actor.user.username,
    });
    result = { token: created.invitation, expiresAt: created.expiresAt };
  } else if (input.action === "submit-token") {
    await connectToFleetHub(actor, input.token, origin);
    result = { connected: true };
  } else if (input.action === "rename") {
    await renameConnectedServer(input.id, input.nickname);
    result = { renamed: true };
  } else {
    result =
      input.direction === "outgoing"
        ? await disconnectFleetNodeFromHub(input.id, actor)
        : await disconnectNodeFromHub(actor, input.id);
  }
  await audit(
    `connections.${input.action}`,
    "success",
    auditContext({
      actor: actor.user,
      target: {
        type: "server-connection",
        id: "id" in input ? input.id : "local",
      },
    }),
  );
  return result;
}
