import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { decorateUser } from "@/server/auth/panel-roles";
import type { PanelActor } from "@/server/auth/site-access";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { executeFleetAction } from "@/server/fleet/actions";
import {
  createFleetEnvelope,
  generateFleetKeyPair,
  verifyFleetEnvelope,
} from "@/server/fleet/crypto";
import { parseFleetOrigin, postFleetJson } from "@/server/fleet/network";
import {
  consumeReplay,
  fleetSecret,
  getFleetState,
  hashFleetSecret,
  matchesFleetSecret,
  mutateFleetState,
} from "@/server/fleet/store";
import {
  FLEET_CAPABILITIES,
  FLEET_MAX_NODES,
  FLEET_PROTOCOL_VERSION,
  type FleetActionName,
  type FleetCapability,
  type FleetConnection,
  type FleetHealthSnapshot,
  type FleetNodeDescriptor,
  type FleetRollingUpdate,
  type FleetServerSummary,
  type FleetSignedEnvelope,
} from "@/server/fleet/types";
import { audit, auditContext } from "@/server/security/log";

const invitationSchema = z
  .object({
    v: z.literal(FLEET_PROTOCOL_VERSION),
    hubId: z.string().uuid(),
    hubOrigin: z.string(),
    code: z.string().min(32).max(100),
  })
  .strict();

const enrollmentSchema = z
  .object({
    invitation: z.string().min(40).max(4096),
    descriptor: z
      .object({
        nodeId: z.string().uuid(),
        label: z.string().min(1).max(100),
        origin: z.string(),
        panelVersion: z.string().max(40),
        brokerProtocolVersion: z.number().int().positive(),
        fleetProtocolVersion: z.number().int().positive(),
        capabilities: z.array(z.enum(FLEET_CAPABILITIES)).max(50),
        publicKey: z.string().min(80).max(2048),
      })
      .strict(),
    owner: z
      .object({
        id: z.string().min(1).max(100),
        username: z.string().min(1).max(100),
      })
      .strict(),
  })
  .strict();

function invitationText(input: {
  hubId: string;
  hubOrigin: string;
  code: string;
}) {
  return `pnl_fleet_${Buffer.from(JSON.stringify({ v: FLEET_PROTOCOL_VERSION, ...input }), "utf8").toString("base64url")}`;
}

function fleetResultSummary(value: unknown) {
  if (!value || typeof value !== "object") return { kind: typeof value };
  const record = value as Record<string, unknown>;
  return {
    kind: "object",
    status: typeof record.status === "string" ? record.status : undefined,
    keys: Object.keys(record)
      .filter(
        (key) =>
          !/(secret|password|token|key|configuration|profile|credential)/i.test(
            key,
          ),
      )
      .slice(0, 12),
  };
}

export function parseFleetInvitation(value: string) {
  if (!value.startsWith("pnl_fleet_"))
    throw new AppError(
      "INVALID_REQUEST",
      "The Fleet invitation is invalid.",
      400,
    );
  try {
    return invitationSchema.parse(
      JSON.parse(Buffer.from(value.slice(10), "base64url").toString("utf8")),
    );
  } catch {
    throw new AppError(
      "INVALID_REQUEST",
      "The Fleet invitation is invalid or incomplete.",
      400,
    );
  }
}

async function releaseMetadata() {
  const value = JSON.parse(
    await readFile(join(process.cwd(), "package.json"), "utf8"),
  ) as {
    version?: string;
    panelavo?: {
      brokerProtocolVersion?: number;
      fleetProtocolVersion?: number;
    };
  };
  return {
    panelVersion: String(value.version ?? "unknown"),
    brokerProtocolVersion: Number(value.panelavo?.brokerProtocolVersion ?? 0),
    fleetProtocolVersion: Number(value.panelavo?.fleetProtocolVersion ?? 0),
  };
}

export async function getFleetPublicState() {
  const state = await getFleetState();
  return {
    mode: state.mode,
    localNodeId: state.localNodeId,
    hub: state.hub,
    nodeLink: state.nodeLink
      ? {
          connectionId: state.nodeLink.connectionId,
          hubId: state.nodeLink.hubId,
          hubOrigin: state.nodeLink.hubOrigin,
          hubLabel: state.nodeLink.hubLabel,
          owner: state.nodeLink.owner,
          status: state.nodeLink.status,
          createdAt: state.nodeLink.createdAt,
          connectedAt: state.nodeLink.connectedAt,
        }
      : undefined,
    nodes: state.nodes.map((connection) => ({
      id: connection.id,
      node: { ...connection.node, publicKey: undefined },
      owner: connection.owner,
      createdAt: connection.createdAt,
      connectedAt: connection.connectedAt,
      lastSeenAt: connection.lastSeenAt,
      lastError: connection.lastError,
      status: connection.status,
    })),
    health: state.health,
    rollingUpdates: state.rollingUpdates,
  };
}

export async function enableFleetHub(label: string, origin: string) {
  const canonical = parseFleetOrigin(origin);
  return mutateFleetState((state) => {
    if (state.mode === "node")
      throw new AppError(
        "INVALID_REQUEST",
        "Disconnect this panel from its current Fleet Hub first.",
        409,
      );
    if (state.mode === "hub") return state.hub!;
    const hub = {
      id: randomUUID(),
      label: label.trim().slice(0, 100) || "Panelavo Fleet",
      origin: canonical,
      enabledAt: new Date().toISOString(),
    };
    state.mode = "hub";
    state.hub = hub;
    return hub;
  });
}

export async function createFleetInvitation(actor: {
  id: string;
  username: string;
}) {
  return mutateFleetState((state) => {
    if (state.mode !== "hub" || !state.hub)
      throw new AppError(
        "INVALID_REQUEST",
        "Enable Fleet Hub mode first.",
        409,
      );
    if (state.nodes.length >= FLEET_MAX_NODES)
      throw new AppError(
        "INVALID_REQUEST",
        "This Fleet Hub already has 100 connected Nodes.",
        409,
      );
    const code = fleetSecret();
    const invitation = {
      id: randomUUID(),
      codeHash: hashFleetSecret(code),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      createdBy: actor,
    };
    state.invitations.push(invitation);
    return {
      invitation: invitationText({
        hubId: state.hub.id,
        hubOrigin: state.hub.origin,
        code,
      }),
      expiresAt: invitation.expiresAt,
    };
  });
}

export async function acceptFleetEnrollment(raw: unknown) {
  const input = enrollmentSchema.parse(raw);
  const invitation = parseFleetInvitation(input.invitation);
  const descriptor = {
    ...input.descriptor,
    origin: parseFleetOrigin(input.descriptor.origin),
  };
  if (descriptor.fleetProtocolVersion !== FLEET_PROTOCOL_VERSION)
    throw new AppError(
      "INVALID_REQUEST",
      "The Node uses an incompatible Fleet protocol.",
      409,
    );
  return mutateFleetState((state) => {
    if (
      state.mode !== "hub" ||
      !state.hub ||
      state.hub.id !== invitation.hubId ||
      state.hub.origin !== invitation.hubOrigin
    )
      throw new AppError(
        "FORBIDDEN",
        "This Fleet invitation does not belong to this Hub.",
        403,
      );
    if (
      descriptor.nodeId === state.localNodeId ||
      descriptor.origin === state.hub.origin
    )
      throw new AppError(
        "INVALID_REQUEST",
        "A Fleet Hub cannot connect to itself.",
        409,
      );
    if (
      state.nodes.some(
        (item) =>
          item.node.nodeId === descriptor.nodeId ||
          item.node.origin === descriptor.origin,
      )
    )
      throw new AppError(
        "INVALID_REQUEST",
        "This Node is already connected.",
        409,
      );
    const storedInvitation = state.invitations.find(
      (item) =>
        Date.parse(item.expiresAt) > Date.now() &&
        matchesFleetSecret(invitation.code, item.codeHash),
    );
    if (!storedInvitation)
      throw new AppError(
        "FORBIDDEN",
        "The Fleet invitation expired or was already used.",
        403,
      );
    state.invitations = state.invitations.filter(
      (item) => item.id !== storedInvitation.id,
    );
    const keys = generateFleetKeyPair();
    const connection: FleetConnection = {
      id: randomUUID(),
      node: descriptor,
      hubId: state.hub.id,
      hubPublicKey: keys.publicKey,
      hubPrivateKey: keys.privateKey,
      owner: input.owner,
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    state.nodes.push(connection);
    return {
      connectionId: connection.id,
      hubId: state.hub.id,
      hubLabel: state.hub.label,
      hubOrigin: state.hub.origin,
      hubPublicKey: keys.publicKey,
    };
  });
}

async function localDescriptor(
  actor: PanelActor,
  origin: string,
  publicKey: string,
): Promise<FleetNodeDescriptor> {
  const [metadata, info] = await Promise.all([
    releaseMetadata(),
    getCloudPanelClient().getServerInfo(actor.cloudPanel),
  ]);
  return {
    nodeId: (await getFleetState()).localNodeId,
    label: info.hostname || new URL(origin).hostname,
    origin: parseFleetOrigin(origin),
    ...metadata,
    capabilities: [...FLEET_CAPABILITIES],
    publicKey,
  };
}

export async function connectToFleetHub(
  actor: PanelActor,
  invitationValue: string,
  localOrigin: string,
) {
  const invitation = parseFleetInvitation(invitationValue);
  const state = await getFleetState();
  if (state.mode !== "standalone")
    throw new AppError(
      "INVALID_REQUEST",
      "This panel is already using Fleet mode.",
      409,
    );
  const keys = generateFleetKeyPair();
  const descriptor = await localDescriptor(actor, localOrigin, keys.publicKey);
  const enrollment = await postFleetJson<{
    success: true;
    data: {
      connectionId: string;
      hubId: string;
      hubLabel: string;
      hubOrigin: string;
      hubPublicKey: string;
    };
  }>(invitation.hubOrigin, "/api/federation/v1/enroll", {
    invitation: invitationValue,
    descriptor,
    owner: { id: actor.user.id, username: actor.user.username },
  });
  const result = enrollment.data;
  if (
    !result ||
    result.hubId !== invitation.hubId ||
    result.hubOrigin !== invitation.hubOrigin
  )
    throw new AppError(
      "REMOTE_ERROR",
      "The Fleet Hub returned an invalid enrollment response.",
      502,
    );
  await mutateFleetState((current) => {
    if (current.mode !== "standalone")
      throw new AppError(
        "INVALID_REQUEST",
        "Fleet mode changed while connecting.",
        409,
      );
    current.mode = "node";
    current.nodeLink = {
      connectionId: result.connectionId,
      hubId: result.hubId,
      hubOrigin: result.hubOrigin,
      hubLabel: result.hubLabel,
      hubPublicKey: result.hubPublicKey,
      nodePrivateKey: keys.privateKey,
      nodePublicKey: keys.publicKey,
      owner: { id: actor.user.id, username: actor.user.username },
      createdAt: new Date().toISOString(),
      status: "pending",
    };
  });
  const envelope = createFleetEnvelope(
    { ready: true },
    {
      typ: "panelavo-federation-request+json",
      connectionId: result.connectionId,
      issuerId: descriptor.nodeId,
      audienceId: result.hubId,
      actorId: actor.user.id,
      actorUsername: actor.user.username,
      action: "fleet.handshake",
    },
    keys.privateKey,
  );
  await postFleetJson(
    invitation.hubOrigin,
    "/api/federation/v1/handshake",
    envelope,
  );
  await mutateFleetState((current) => {
    if (current.nodeLink?.connectionId === result.connectionId) {
      current.nodeLink.status = "online";
      current.nodeLink.connectedAt = new Date().toISOString();
    }
  });
  return getFleetPublicState();
}

async function fleetActorForNode() {
  const state = await getFleetState();
  const link = state.nodeLink;
  if (state.mode !== "node" || !link)
    throw new AppError(
      "FORBIDDEN",
      "This panel is not connected as a Fleet Node.",
      403,
    );
  const cloudPanel = {
    cookies: {},
    usernameHint: link.owner.username,
    cliAuthenticated: true,
  } as const;
  try {
    const user = await decorateUser(
      await getCloudPanelClient().getCurrentUser(cloudPanel),
    );
    if (
      user.id !== link.owner.id ||
      user.username.toLowerCase() !== link.owner.username.toLowerCase() ||
      user.status === false ||
      user.panelRole !== "super-admin"
    )
      throw new Error("owner unavailable");
    return {
      link,
      actor: {
        user,
        cloudPanel,
        authentication: "fleet",
        credentialId: link.connectionId,
      } as PanelActor,
    };
  } catch {
    await mutateFleetState((current) => {
      if (current.nodeLink) current.nodeLink.status = "suspended";
    });
    throw new AppError(
      "FORBIDDEN",
      "The Super Admin who authorized this Fleet connection is no longer active.",
      403,
    );
  }
}

export async function executeFederationRequest(envelope: FleetSignedEnvelope) {
  const { link, actor } = await fleetActorForNode();
  const expected = {
    typ: "panelavo-federation-request+json" as const,
    connectionId: link.connectionId,
    issuerId: link.hubId,
    audienceId: (await getFleetState()).localNodeId,
  };
  let verified;
  try {
    verified = verifyFleetEnvelope<unknown>(
      envelope,
      link.hubPublicKey,
      expected,
    );
  } catch (error) {
    if (
      !link.previousHubPublicKey ||
      Date.parse(link.previousHubPublicKeyExpiresAt ?? "") <= Date.now()
    )
      throw error;
    verified = verifyFleetEnvelope<unknown>(
      envelope,
      link.previousHubPublicKey,
      expected,
    );
  }
  if (!(await consumeReplay(link.connectionId, verified.protected.requestId)))
    throw new AppError(
      "FORBIDDEN",
      "The federation request was already used.",
      401,
    );
  const action = verified.protected.action as FleetActionName;
  let result: unknown;
  try {
    if (action === "fleet.rotate-key") {
      const input = z
        .object({ publicKey: z.string().min(80).max(2048) })
        .strict()
        .parse(verified.payload);
      await mutateFleetState((state) => {
        if (state.nodeLink?.connectionId !== link.connectionId) return;
        state.nodeLink.previousHubPublicKey = state.nodeLink.hubPublicKey;
        state.nodeLink.previousHubPublicKeyExpiresAt = new Date(
          Date.now() + 10 * 60_000,
        ).toISOString();
        state.nodeLink.hubPublicKey = input.publicKey;
      });
      result = { rotated: true };
    } else result = await executeFleetAction(actor, action, verified.payload);
    await audit(
      `fleet.${action}`,
      "success",
      auditContext({
        actor: actor.user,
        target: { type: "fleet", id: link.connectionId },
        details: {
          hubActor: verified.protected.actorUsername,
          connectionOwner: link.owner.username,
          serverId: (await getFleetState()).localNodeId,
          requestId: verified.protected.requestId,
          result: fleetResultSummary(result),
        },
      }),
    );
  } catch (error) {
    await audit(
      `fleet.${action}`,
      "failure",
      auditContext({
        actor: actor.user,
        target: { type: "fleet", id: link.connectionId },
        error,
        details: {
          hubActor: verified.protected.actorUsername,
          connectionOwner: link.owner.username,
          serverId: (await getFleetState()).localNodeId,
          requestId: verified.protected.requestId,
        },
      }),
    );
    throw error;
  }
  return createFleetEnvelope(
    result,
    {
      typ: "panelavo-federation-response+json",
      connectionId: link.connectionId,
      issuerId: (await getFleetState()).localNodeId,
      audienceId: link.hubId,
      actorId: actor.user.id,
      actorUsername: actor.user.username,
      action,
    },
    link.nodePrivateKey,
  );
}

function fleetActionTimeout(action: FleetActionName) {
  if (action === "system.summary") return 15_000;
  if (
    [
      "sites.create",
      "site.update",
      "site.delete",
      "site.section.manage",
    ].includes(action)
  )
    return 1_900_000;
  return 30_000;
}

export function fleetCapabilityForAction(
  action: FleetActionName,
): FleetCapability | undefined {
  if (action === "fleet.rotate-key") return undefined;
  if (action === "system.storage" || action.startsWith("system.storage."))
    return "system.storage";
  if (action.startsWith("system.update.")) return "system.update";
  if (action.startsWith("system.")) return "system.read";
  if (action === "sites.list" || action === "sites.creation-details")
    return "sites.read";
  if (
    action === "site.get" ||
    action.endsWith(".get") ||
    action === "site.services.list"
  )
    return "site-sections.read";
  if (
    action.startsWith("sites.") ||
    ["site.update", "site.delete"].includes(action)
  )
    return "sites.write";
  if (action.startsWith("site.")) return "site-sections.write";
  if (action === "users.list") return "users.read";
  if (action === "users.manage") return "users.write";
  if (action === "vpn.get") return "vpn.read";
  if (action === "vpn.manage") return "vpn.write";
  if (action === "audit.list") return "audit.read";
  return undefined;
}

export async function callFleetNode(
  connection: FleetConnection,
  action: FleetActionName,
  input: unknown,
  hubActor: { id: string; username: string },
) {
  const capability = fleetCapabilityForAction(action);
  if (capability && !connection.node.capabilities.includes(capability))
    throw new AppError(
      "FORBIDDEN",
      `This Node does not advertise the ${capability} Fleet capability.`,
      409,
    );
  const envelope = createFleetEnvelope(
    input,
    {
      typ: "panelavo-federation-request+json",
      connectionId: connection.id,
      issuerId: connection.hubId,
      audienceId: connection.node.nodeId,
      actorId: hubActor.id,
      actorUsername: hubActor.username,
      action,
    },
    connection.hubPrivateKey,
  );
  const response = await postFleetJson<FleetSignedEnvelope>(
    connection.node.origin,
    "/api/federation/v1/execute",
    envelope,
    fleetActionTimeout(action),
  );
  const verified = verifyFleetEnvelope<unknown>(
    response,
    connection.node.publicKey,
    {
      typ: "panelavo-federation-response+json",
      connectionId: connection.id,
      issuerId: connection.node.nodeId,
      audienceId: connection.hubId,
      action,
    },
  );
  return {
    payload: verified.payload,
    requestId: JSON.parse(
      Buffer.from(envelope.protected, "base64url").toString("utf8"),
    ).requestId as string,
  };
}

export async function completeFleetHandshake(envelope: FleetSignedEnvelope) {
  const protectedPreview = JSON.parse(
    Buffer.from(envelope.protected, "base64url").toString("utf8"),
  ) as { connectionId?: string };
  const state = await getFleetState();
  if (state.mode !== "hub")
    throw new AppError("FORBIDDEN", "This panel is not a Fleet Hub.", 403);
  const connection = state.nodes.find(
    (item) => item.id === protectedPreview.connectionId,
  );
  if (!connection)
    throw new AppError("FORBIDDEN", "The Fleet connection is unknown.", 403);
  const verified = verifyFleetEnvelope(envelope, connection.node.publicKey, {
    typ: "panelavo-federation-request+json",
    connectionId: connection.id,
    issuerId: connection.node.nodeId,
    audienceId: connection.hubId,
    action: "fleet.handshake",
  });
  if (!(await consumeReplay(connection.id, verified.protected.requestId)))
    throw new AppError(
      "FORBIDDEN",
      "The federation request was already used.",
      401,
    );
  await callFleetNode(
    connection,
    "system.summary",
    {},
    { id: "fleet-enrollment", username: connection.owner.username },
  );
  await mutateFleetState((current) => {
    const item = current.nodes.find((node) => node.id === connection.id);
    if (item) {
      item.status = "online";
      item.connectedAt = new Date().toISOString();
      item.lastSeenAt = item.connectedAt;
      item.lastError = undefined;
    }
  });
  return { connected: true };
}

export async function dispatchFleetAction(
  serverId: string,
  action: FleetActionName,
  input: unknown,
  localActor: PanelActor,
) {
  if (serverId === "local") {
    try {
      const result = await executeFleetAction(localActor, action, input);
      await audit(
        `fleet.dispatch.${action}`,
        "success",
        auditContext({
          actor: localActor.user,
          target: { type: "fleet-node", id: "local" },
          details: { serverId: "local", result: fleetResultSummary(result) },
        }),
      );
      return result;
    } catch (error) {
      await audit(
        `fleet.dispatch.${action}`,
        "failure",
        auditContext({
          actor: localActor.user,
          target: { type: "fleet-node", id: "local" },
          error,
        }),
      );
      throw error;
    }
  }
  const state = await getFleetState();
  if (state.mode !== "hub")
    throw new AppError("FORBIDDEN", "This panel is not a Fleet Hub.", 403);
  const connection = state.nodes.find((item) => item.id === serverId);
  if (!connection)
    throw new AppError("SITE_NOT_FOUND", "Fleet server not found.", 404);
  const started = Date.now();
  try {
    const called = await callFleetNode(connection, action, input, {
      id: localActor.user.id,
      username: localActor.user.username,
    });
    const result = called.payload;
    await mutateFleetState((current) => {
      const item = current.nodes.find((node) => node.id === connection.id);
      if (!item) return;
      const summary =
        action === "system.summary"
          ? (result as FleetServerSummary)
          : undefined;
      const pressured = summary
        ? Math.max(
            summary.resources.cpu.usedPercent,
            summary.resources.memory.usedPercent,
            summary.resources.disk.usedPercent,
          ) >= 90
        : false;
      item.status = pressured ? "degraded" : "online";
      item.lastSeenAt = new Date().toISOString();
      item.lastError = undefined;
      current.health[connection.id] = {
        serverId: connection.id,
        label: connection.node.label,
        origin: connection.node.origin,
        status: item.status,
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
        lastSuccessfulAt: new Date().toISOString(),
        ...(summary ? { summary } : {}),
      };
    });
    await audit(
      `fleet.dispatch.${action}`,
      "success",
      auditContext({
        actor: localActor.user,
        target: { type: "fleet-node", id: connection.id },
        details: {
          node: connection.node.label,
          connectionOwner: connection.owner.username,
          serverId: connection.node.nodeId,
          requestId: called.requestId,
          result: fleetResultSummary(result),
        },
      }),
    );
    return result;
  } catch (error) {
    await mutateFleetState((current) => {
      const item = current.nodes.find((node) => node.id === connection.id);
      if (item) {
        item.status = item.status === "suspended" ? "suspended" : "offline";
        item.lastError =
          error instanceof Error ? error.message : "Connection failed";
        current.health[connection.id] = {
          serverId: connection.id,
          label: connection.node.label,
          origin: connection.node.origin,
          status: item.status,
          checkedAt: new Date().toISOString(),
          lastSuccessfulAt: current.health[connection.id]?.lastSuccessfulAt,
          error: item.lastError,
        };
      }
    });
    await audit(
      `fleet.dispatch.${action}`,
      "failure",
      auditContext({
        actor: localActor.user,
        target: { type: "fleet-node", id: connection.id },
        error,
      }),
    );
    throw error;
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await mapper(items[index]);
      }
    }),
  );
  return results;
}

export async function refreshFleetServers(localActor: PanelActor) {
  const state = await getFleetState();
  const localStarted = Date.now();
  const localSummary = (await executeFleetAction(
    localActor,
    "system.summary",
    {},
  )) as FleetServerSummary;
  localSummary.nodeId = state.localNodeId;
  const localHealth: FleetHealthSnapshot = {
    serverId: "local",
    label: localSummary.label,
    origin: "local",
    status: "online",
    latencyMs: Date.now() - localStarted,
    checkedAt: new Date().toISOString(),
    lastSuccessfulAt: new Date().toISOString(),
    summary: localSummary,
  };
  const remote =
    state.mode === "hub"
      ? await mapLimit(state.nodes, 5, async (connection) => {
          try {
            await dispatchFleetAction(
              connection.id,
              "system.summary",
              {},
              localActor,
            );
          } catch {
            /* the stored health contains the isolated failure */
          }
          return (await getFleetState()).health[connection.id];
        })
      : [];
  await mutateFleetState((current) => {
    current.health.local = localHealth;
  });
  return [localHealth, ...remote.filter(Boolean)];
}

export async function refreshFleetNodesInBackground() {
  const state = await getFleetState();
  if (state.mode !== "hub") return [];
  return mapLimit(state.nodes, 5, async (connection) => {
    const started = Date.now();
    try {
      const result = (
        await callFleetNode(
          connection,
          "system.summary",
          {},
          { id: "fleet-health", username: "fleet-health" },
        )
      ).payload as FleetServerSummary;
      const pressured =
        Math.max(
          result.resources.cpu.usedPercent,
          result.resources.memory.usedPercent,
          result.resources.disk.usedPercent,
        ) >= 90;
      const now = new Date().toISOString();
      const snapshot: FleetHealthSnapshot = {
        serverId: connection.id,
        label: connection.node.label,
        origin: connection.node.origin,
        status: pressured ? "degraded" : "online",
        latencyMs: Date.now() - started,
        checkedAt: now,
        lastSuccessfulAt: now,
        summary: result,
      };
      await mutateFleetState((current) => {
        const item = current.nodes.find((node) => node.id === connection.id);
        if (item) {
          item.status = snapshot.status;
          item.lastSeenAt = now;
          item.lastError = undefined;
        }
        current.health[connection.id] = snapshot;
      });
      return snapshot;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Connection failed";
      const snapshot: FleetHealthSnapshot = {
        serverId: connection.id,
        label: connection.node.label,
        origin: connection.node.origin,
        status: "offline",
        checkedAt: new Date().toISOString(),
        lastSuccessfulAt: state.health[connection.id]?.lastSuccessfulAt,
        error: message,
      };
      await mutateFleetState((current) => {
        const item = current.nodes.find((node) => node.id === connection.id);
        if (item) {
          item.status = item.status === "suspended" ? "suspended" : "offline";
          item.lastError = message;
          snapshot.status = item.status;
        }
        current.health[connection.id] = snapshot;
      });
      return snapshot;
    }
  });
}

export async function rotateFleetConnection(
  serverId: string,
  actor: PanelActor,
) {
  const state = await getFleetState();
  const connection = state.nodes.find((item) => item.id === serverId);
  if (!connection)
    throw new AppError("SITE_NOT_FOUND", "Fleet server not found.", 404);
  const keys = generateFleetKeyPair();
  await callFleetNode(
    connection,
    "fleet.rotate-key",
    { publicKey: keys.publicKey },
    { id: actor.user.id, username: actor.user.username },
  );
  await mutateFleetState((current) => {
    const item = current.nodes.find((node) => node.id === serverId);
    if (item) {
      item.hubPrivateKey = keys.privateKey;
      item.hubPublicKey = keys.publicKey;
    }
  });
  return { rotated: true };
}

export async function disconnectFleet(serverId?: string) {
  return mutateFleetState((state) => {
    if (state.mode === "node") {
      state.mode = "standalone";
      state.nodeLink = undefined;
      return;
    }
    if (state.mode === "hub" && serverId) {
      state.nodes = state.nodes.filter((item) => item.id !== serverId);
      delete state.health[serverId];
      return;
    }
    if (state.mode === "hub" && !serverId) {
      if (state.nodes.length)
        throw new AppError(
          "INVALID_REQUEST",
          "Disconnect every Fleet Node before disabling the Hub.",
          409,
        );
      state.mode = "standalone";
      state.hub = undefined;
      state.invitations = [];
      state.health = {};
    }
  });
}

export async function revokeFederationRequest(envelope: FleetSignedEnvelope) {
  const preview = JSON.parse(
    Buffer.from(envelope.protected, "base64url").toString("utf8"),
  ) as { connectionId?: string };
  const state = await getFleetState();
  const nodeLink = state.nodeLink;
  if (
    state.mode === "node" &&
    nodeLink &&
    nodeLink.connectionId === preview.connectionId
  ) {
    const link = nodeLink;
    const verified = verifyFleetEnvelope(envelope, link.hubPublicKey, {
      typ: "panelavo-federation-request+json",
      connectionId: link.connectionId,
      issuerId: link.hubId,
      audienceId: state.localNodeId,
      action: "fleet.revoke",
    });
    if (!(await consumeReplay(link.connectionId, verified.protected.requestId)))
      throw new AppError(
        "FORBIDDEN",
        "The federation request was already used.",
        401,
      );
    await disconnectFleet();
    return { revoked: true };
  }
  if (state.mode === "hub") {
    const connection = state.nodes.find(
      (item) => item.id === preview.connectionId,
    );
    if (!connection)
      throw new AppError("FORBIDDEN", "The Fleet connection is unknown.", 403);
    const verified = verifyFleetEnvelope(envelope, connection.node.publicKey, {
      typ: "panelavo-federation-request+json",
      connectionId: connection.id,
      issuerId: connection.node.nodeId,
      audienceId: connection.hubId,
      action: "fleet.revoke",
    });
    if (!(await consumeReplay(connection.id, verified.protected.requestId)))
      throw new AppError(
        "FORBIDDEN",
        "The federation request was already used.",
        401,
      );
    await disconnectFleet(connection.id);
    return { revoked: true };
  }
  throw new AppError("FORBIDDEN", "The Fleet connection is unknown.", 403);
}

export async function disconnectNodeFromHub(actor: PanelActor) {
  const state = await getFleetState();
  const link = state.nodeLink;
  if (state.mode !== "node" || !link)
    throw new AppError(
      "INVALID_REQUEST",
      "This panel is not connected to a Fleet Hub.",
      409,
    );
  const envelope = createFleetEnvelope(
    {},
    {
      typ: "panelavo-federation-request+json",
      connectionId: link.connectionId,
      issuerId: state.localNodeId,
      audienceId: link.hubId,
      actorId: actor.user.id,
      actorUsername: actor.user.username,
      action: "fleet.revoke",
    },
    link.nodePrivateKey,
  );
  await postFleetJson(
    link.hubOrigin,
    "/api/federation/v1/revoke",
    envelope,
  ).catch(() => undefined);
  await disconnectFleet();
  return { disconnected: true };
}

export async function disconnectFleetNodeFromHub(
  serverId: string,
  actor: PanelActor,
) {
  const state = await getFleetState();
  const connection = state.nodes.find((item) => item.id === serverId);
  if (!connection)
    throw new AppError("SITE_NOT_FOUND", "Fleet server not found.", 404);
  const envelope = createFleetEnvelope(
    {},
    {
      typ: "panelavo-federation-request+json",
      connectionId: connection.id,
      issuerId: connection.hubId,
      audienceId: connection.node.nodeId,
      actorId: actor.user.id,
      actorUsername: actor.user.username,
      action: "fleet.revoke",
    },
    connection.hubPrivateKey,
  );
  await postFleetJson(
    connection.node.origin,
    "/api/federation/v1/revoke",
    envelope,
  ).catch(() => undefined);
  await disconnectFleet(serverId);
  return { disconnected: true };
}

export async function revokeFleetAuthorizationForUser(user: {
  id: string;
  username: string;
}) {
  return mutateFleetState((state) => {
    if (state.mode !== "node" || !state.nodeLink) return false;
    if (
      state.nodeLink.owner.id !== user.id &&
      state.nodeLink.owner.username.toLowerCase() !==
        user.username.toLowerCase()
    )
      return false;
    state.mode = "standalone";
    state.nodeLink = undefined;
    return true;
  });
}

const activeRollingUpdates = new Set<string>();
const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function updateRollingRecord(
  id: string,
  patch: Partial<FleetRollingUpdate>,
) {
  await mutateFleetState((state) => {
    const record = state.rollingUpdates.find((item) => item.id === id);
    if (record)
      Object.assign(record, patch, { updatedAt: new Date().toISOString() });
  });
}

async function runFleetRollingUpdate(id: string) {
  if (activeRollingUpdates.has(id)) return;
  activeRollingUpdates.add(id);
  try {
    const state = await getFleetState();
    const job = state.rollingUpdates.find((item) => item.id === id);
    if (!job || !["queued", "running"].includes(job.status)) return;
    await updateRollingRecord(id, { status: "running", error: undefined });
    for (const serverId of job.serverIds) {
      const current = (await getFleetState()).rollingUpdates.find(
        (item) => item.id === id,
      );
      if (!current || current.completedServerIds.includes(serverId)) continue;
      const connection = (await getFleetState()).nodes.find(
        (item) => item.id === serverId,
      );
      if (!connection)
        throw new Error(`Fleet Node ${serverId} is no longer connected.`);
      await updateRollingRecord(id, { currentServerId: serverId });
      const checked = (
        await callFleetNode(
          connection,
          "system.update.get",
          { check: true },
          job.createdBy,
        )
      ).payload as { status?: string; error?: string; notice?: string };
      if (["blocked", "diverged", "failed"].includes(String(checked.status)))
        throw new Error(
          checked.error ||
            checked.notice ||
            `Update check returned ${checked.status}.`,
        );
      if (!["current", "ahead", "complete"].includes(String(checked.status))) {
        await callFleetNode(
          connection,
          "system.update.start",
          { confirmation: "UPDATE PANELAVO" },
          job.createdBy,
        );
        const deadline = Date.now() + 35 * 60_000;
        let unreachableSince: number | undefined;
        while (Date.now() < deadline) {
          await wait(10_000);
          let result: { status?: string; error?: string };
          try {
            result = (
              await callFleetNode(
                connection,
                "system.update.get",
                {},
                job.createdBy,
              )
            ).payload as { status?: string; error?: string };
            unreachableSince = undefined;
          } catch (error) {
            unreachableSince ??= Date.now();
            if (Date.now() - unreachableSince < 3 * 60_000) continue;
            throw error;
          }
          if (["complete", "current", "ahead"].includes(String(result.status)))
            break;
          if (["failed", "blocked", "diverged"].includes(String(result.status)))
            throw new Error(
              result.error || `Update returned ${result.status}.`,
            );
          if (Date.now() + 10_000 >= deadline)
            throw new Error(
              "The Node update did not finish within 35 minutes.",
            );
        }
      }
      await mutateFleetState((next) => {
        const record = next.rollingUpdates.find((item) => item.id === id);
        if (record && !record.completedServerIds.includes(serverId))
          record.completedServerIds.push(serverId);
        if (record) record.updatedAt = new Date().toISOString();
      });
    }
    await updateRollingRecord(id, {
      status: "complete",
      currentServerId: undefined,
    });
  } catch (error) {
    await updateRollingRecord(id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Rolling update failed.",
    });
  } finally {
    activeRollingUpdates.delete(id);
  }
}

export async function startFleetRollingUpdate(
  serverIds: string[],
  actor: PanelActor,
) {
  const state = await getFleetState();
  if (state.mode !== "hub")
    throw new AppError("FORBIDDEN", "This panel is not a Fleet Hub.", 403);
  const unique = [...new Set(serverIds)];
  if (
    !unique.length ||
    unique.length > FLEET_MAX_NODES ||
    unique.some((id) => !state.nodes.some((node) => node.id === id))
  )
    throw new AppError(
      "INVALID_REQUEST",
      "Select one or more connected Fleet Nodes.",
      400,
    );
  const now = new Date().toISOString();
  const job: FleetRollingUpdate = {
    id: randomUUID(),
    serverIds: unique,
    completedServerIds: [],
    status: "queued",
    createdBy: { id: actor.user.id, username: actor.user.username },
    createdAt: now,
    updatedAt: now,
  };
  await mutateFleetState((next) => {
    next.rollingUpdates.push(job);
  });
  void runFleetRollingUpdate(job.id);
  return job;
}

export async function resumeFleetRollingUpdates() {
  const state = await getFleetState();
  for (const job of state.rollingUpdates.filter(
    (item) => item.status === "queued" || item.status === "running",
  ))
    void runFleetRollingUpdate(job.id);
  return state.rollingUpdates;
}
