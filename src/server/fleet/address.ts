import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { PanelActor } from "@/server/auth/site-access";
import { AppError } from "@/server/cloudpanel/errors";
import { createFleetEnvelope, verifyFleetEnvelope } from "./crypto";
import { parseFleetOrigin, postFleetJson } from "./network";
import { consumeReplay, getFleetState, mutateFleetState } from "./store";
import { fleetActorForNode } from "./service";
import type { FleetSignedEnvelope } from "./types";
import {
  getPanelAddressState,
  savePanelAddressState,
} from "@/server/settings/panel-address-store";
import { audit } from "@/server/security/log";

const endpoint = "/api/federation/v1/address";
const changeSchema = z
  .object({
    origin: z.string().transform(parseFleetOrigin),
    previousOrigin: z.string().transform(parseFleetOrigin),
    revision: z.number().int().positive(),
  })
  .strict();
const nonce = () => randomBytes(32).toString("base64url");

async function peer(id: string) {
  const state = await getFleetState();
  const outgoing = state.nodes.find((item) => item.id === id);
  const incoming = state.nodeLinks.find((item) => item.connectionId === id);
  if (incoming) {
    await fleetActorForNode(id);
    return {
      id,
      localId: state.localNodeId,
      remoteId: incoming.hubId,
      origin: incoming.hubOrigin,
      publicKey: incoming.hubPublicKey,
      privateKey: incoming.nodePrivateKey,
      revision: incoming.addressRevision || 0,
    };
  }
  if (outgoing && outgoing.status !== "suspended")
    return {
      id,
      localId: outgoing.hubId,
      remoteId: outgoing.node.nodeId,
      origin: outgoing.node.origin,
      publicKey: outgoing.node.publicKey,
      privateKey: outgoing.hubPrivateKey,
      revision: outgoing.addressRevision || 0,
    };
  throw new AppError(
    "FORBIDDEN",
    "Unknown or suspended server connection.",
    403,
  );
}
type Peer = Awaited<ReturnType<typeof peer>>;
function sign(p: Peer, action: string, payload: unknown, response = false) {
  return createFleetEnvelope(
    payload,
    {
      typ: response
        ? "panelavo-federation-response+json"
        : "panelavo-federation-request+json",
      connectionId: p.id,
      issuerId: p.localId,
      audienceId: p.remoteId,
      actorId: "panel-address",
      actorUsername: "panel-address",
      action,
    },
    p.privateKey,
  );
}
async function verifyResponse(
  p: Peer,
  action: string,
  envelope: FleetSignedEnvelope,
  requestId: string,
) {
  const verified = verifyFleetEnvelope<{ requestId: string; origin: string }>(
    envelope,
    p.publicKey,
    {
      typ: "panelavo-federation-response+json",
      connectionId: p.id,
      issuerId: p.remoteId,
      audienceId: p.localId,
      action,
    },
  );
  if (
    verified.payload.requestId !== requestId ||
    !(await consumeReplay(p.id, verified.protected.requestId))
  )
    throw new AppError("FORBIDDEN", "Invalid address confirmation.", 401);
  return verified.payload;
}
async function send(
  p: Peer,
  action: string,
  payload: unknown,
  origin = p.origin,
) {
  const envelope = sign(p, action, payload);
  const requestId = JSON.parse(
    Buffer.from(envelope.protected, "base64url").toString(),
  ).requestId as string;
  return verifyResponse(
    p,
    action,
    await postFleetJson<FleetSignedEnvelope>(origin, endpoint, envelope),
    requestId,
  );
}

// Both directions use their existing connection key; a hostname alone never changes trust.
export async function handleAddressEnvelope(envelope: FleetSignedEnvelope) {
  const preview = z
    .object({ connectionId: z.string().uuid() })
    .parse(JSON.parse(Buffer.from(envelope.protected, "base64url").toString()));
  const p = await peer(preview.connectionId);
  const verified = verifyFleetEnvelope(envelope, p.publicKey, {
    typ: "panelavo-federation-request+json",
    connectionId: p.id,
    issuerId: p.remoteId,
    audienceId: p.localId,
  });
  if (!(await consumeReplay(p.id, verified.protected.requestId)))
    throw new AppError("FORBIDDEN", "Address request already used.", 401);
  if (verified.protected.action === "fleet.address.probe") {
    const input = z
      .object({ origin: z.string().transform(parseFleetOrigin) })
      .strict()
      .parse(verified.payload);
    const address = getPanelAddressState();
    if (
      input.origin !== address.origin &&
      input.origin !== address.pending?.origin
    )
      throw new AppError(
        "FORBIDDEN",
        "This address has not been verified on the destination panel.",
        403,
      );
    return sign(
      p,
      verified.protected.action,
      { requestId: verified.protected.requestId, origin: input.origin },
      true,
    );
  }
  if (verified.protected.action !== "fleet.address.update")
    throw new AppError("FORBIDDEN", "Unknown address action.", 403);
  const input = changeSchema.parse(verified.payload);
  if (
    input.revision < p.revision ||
    (input.revision === p.revision && p.origin !== input.origin) ||
    (p.origin !== input.previousOrigin && p.origin !== input.origin)
  )
    throw new AppError("FORBIDDEN", "Stale panel address change.", 409);
  const proof = await send(
    p,
    "fleet.address.probe",
    { origin: input.origin },
    input.origin,
  );
  if (proof.origin !== input.origin)
    throw new AppError(
      "FORBIDDEN",
      "The new address belongs to a different panel.",
      403,
    );
  await mutateFleetState((state) => {
    const item = state.nodes.find((value) => value.id === p.id);
    const link = state.nodeLinks.find((value) => value.connectionId === p.id);
    const currentRevision = item?.addressRevision ?? link?.addressRevision ?? 0;
    if ((!item && !link) || currentRevision > input.revision)
      throw new AppError(
        "FORBIDDEN",
        "Connection changed while verifying its address.",
        409,
      );
    if (item) {
      item.node.origin = input.origin;
      item.addressRevision = input.revision;
    }
    if (link) {
      link.hubOrigin = input.origin;
      link.addressRevision = input.revision;
    }
    if (state.health[p.id]) state.health[p.id].origin = input.origin;
  });
  await audit("connections.address.received", "success", {
    connectionId: p.id,
    origin: input.origin,
    requestId: verified.protected.requestId,
  });
  return sign(
    p,
    verified.protected.action,
    { requestId: verified.protected.requestId, origin: input.origin },
    true,
  );
}

export function answerAddressProof(challenge: string) {
  const state = getPanelAddressState();
  if (
    !state.proof ||
    state.proof.expiresAt < Date.now() ||
    state.proof.challenge !== challenge
  )
    throw new AppError("FORBIDDEN", "Address verification expired.", 403);
  return { proof: state.proof.response };
}

let changing = false;
export async function changePanelAddress(
  originInput: string,
  previousOrigin: string,
  actor: PanelActor,
) {
  if (
    !["session", "fleet"].includes(actor.authentication) ||
    actor.user.panelRole !== "super-admin"
  )
    throw new AppError(
      "FORBIDDEN",
      "Change the address as an authorized Super Admin.",
      403,
    );
  if (actor.authentication === "fleet") {
    const authorized = actor.credentialId
      ? await fleetActorForNode(actor.credentialId)
      : null;
    if (
      !authorized?.link.fullAdmin ||
      authorized.actor.user.id !== actor.user.id
    )
      throw new AppError(
        "FORBIDDEN",
        "Change the address through an authorized full Super Admin connection.",
        403,
      );
  }
  if (changing)
    throw new AppError(
      "INVALID_REQUEST",
      "An address change is already running.",
      409,
    );
  changing = true;
  try {
    const origin = parseFleetOrigin(originInput);
    let address = getPanelAddressState();
    if (address.pending && address.pending.origin !== origin)
      throw new AppError(
        "INVALID_REQUEST",
        "Finish the pending address change first.",
        409,
      );
    if (!address.pending && origin === previousOrigin)
      return { origin, pending: false, remaining: 0 };
    const proof = {
      challenge: nonce(),
      response: nonce(),
      expiresAt: Date.now() + 60_000,
    };
    savePanelAddressState({ ...address, proof });
    try {
      const response = await postFleetJson<{
        success: boolean;
        data: { proof: string };
      }>(origin, "/api/federation/v1/address-proof", {
        challenge: proof.challenge,
      });
      if (response.data?.proof !== proof.response)
        throw new Error("Different panel");
    } catch {
      throw new AppError(
        "INVALID_REQUEST",
        "The new address must route to this same panel with a valid HTTPS certificate, without redirects. Check its DNS and CloudPanel domain/SSL configuration; the current address is unchanged.",
        400,
      );
    } finally {
      const current = getPanelAddressState();
      delete current.proof;
      savePanelAddressState(current);
    }
    address = getPanelAddressState();
    address.pending ??= {
      origin,
      previousOrigin: parseFleetOrigin(previousOrigin),
      revision: address.revision + 1,
      completed: [],
    };
    savePanelAddressState(address);
    const pending = address.pending;
    const state = await getFleetState();
    const ids = [
      ...state.nodes.map((item) => item.id),
      ...state.nodeLinks.map((item) => item.connectionId),
    ];
    const deadline = Date.now() + 45_000;
    for (const id of ids) {
      if (pending.completed.includes(id)) continue;
      if (Date.now() >= deadline) break;
      try {
        const p = await peer(id);
        const confirmed = await send(p, "fleet.address.update", {
          origin,
          previousOrigin: pending.previousOrigin,
          revision: pending.revision,
        });
        if (confirmed.origin !== origin)
          throw new Error("Incorrect address acknowledgement");
        pending.completed.push(id);
        savePanelAddressState(address);
      } catch {
        // Keep both addresses available. The operator can retry after peer recovery/upgrade.
      }
    }
    let remaining = ids.filter((id) => !pending.completed.includes(id)).length;
    if (!remaining) {
      await mutateFleetState((current) => {
        remaining = [
          ...current.nodes.map((item) => item.id),
          ...current.nodeLinks.map((item) => item.connectionId),
        ].filter((id) => !pending.completed.includes(id)).length;
        if (remaining) return;
        if (current.hub) current.hub.origin = origin;
        current.invitations = [];
      });
    }
    if (!remaining) {
      address.origin = origin;
      address.revision = pending.revision;
      address.previousOrigins = [
        ...new Set([...address.previousOrigins, pending.previousOrigin]),
      ];
      delete address.pending;
      savePanelAddressState(address);
    }
    await audit("connections.address.change", "success", {
      actor: actor.user,
      origin,
      remaining,
    });
    return { origin, pending: Boolean(remaining), remaining };
  } finally {
    changing = false;
  }
}
