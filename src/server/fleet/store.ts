import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { encryptedJsonStore } from "@/server/storage/encrypted-json-store";
import type {
  FleetConnection,
  FleetHealthSnapshot,
  FleetInvitation,
  FleetMode,
  FleetNodeLink,
  FleetRollingUpdate,
} from "@/server/fleet/types";

type FleetState = {
  version: 1;
  splitPersistence?: true;
  mode: FleetMode;
  localNodeId: string;
  hub?: { id: string; label: string; origin: string; enabledAt: string };
  nodeLink?: FleetNodeLink;
  nodeLinks: FleetNodeLink[];
  nodes: FleetConnection[];
  invitations: FleetInvitation[];
  replays: { connectionId: string; requestId: string; expiresAt: number }[];
  health: Record<string, FleetHealthSnapshot>;
  rollingUpdates: FleetRollingUpdate[];
};

const store = encryptedJsonStore<FleetState>("fleet-state.enc.json", () => ({
  version: 1,
  mode: "standalone",
  localNodeId: randomUUID(),
  nodes: [],
  nodeLinks: [],
  invitations: [],
  replays: [],
  health: {},
  rollingUpdates: [],
}));
let mutationQueue: Promise<unknown> = Promise.resolve();

function clean(state: FleetState) {
  // Read old single-manager installations without losing their pinned trust.
  state.nodeLinks ??= state.nodeLink ? [state.nodeLink] : [];
  delete state.nodeLink;
  const now = Date.now();
  state.invitations = state.invitations.filter(
    (item) => Date.parse(item.expiresAt) > now,
  );
  state.replays = state.replays.filter((item) => item.expiresAt > now);
  state.rollingUpdates = state.rollingUpdates.slice(-25);
  return state;
}

const healthStore = encryptedJsonStore<FleetState["health"] | null>(
  "fleet-health.enc.json",
  () => null,
);
const replayStore = encryptedJsonStore<FleetState["replays"] | null>(
  "fleet-replays.enc.json",
  () => null,
);

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const operation = mutationQueue.then(work);
  mutationQueue = operation.catch(() => undefined);
  return operation;
}

async function loadState(): Promise<FleetState> {
  const state = clean(await store.load());
  let [health, replays] = await Promise.all([
    healthStore.load(),
    replayStore.load(),
  ]);
  if (!state.splitPersistence) {
    // Write auxiliary files first. A restart during migration can safely repeat
    // the merge without forgetting any request already accepted by either file.
    health = { ...state.health, ...health };
    const seen = new Map<string, FleetState["replays"][number]>();
    for (const entry of [...state.replays, ...(replays ?? [])]) {
      if (entry.expiresAt > Date.now()) {
        const key = JSON.stringify([entry.connectionId, entry.requestId]);
        const previous = seen.get(key);
        if (!previous || previous.expiresAt < entry.expiresAt)
          seen.set(key, entry);
      }
    }
    replays = [...seen.values()];
    await healthStore.save(health);
    await replayStore.save(replays);
    state.splitPersistence = true;
    await store.save({ ...state, health: {}, replays: [] });
  }
  if (replays === null)
    throw new Error(
      "Fleet replay protection is missing; refusing federation requests.",
    );
  state.replays = replays.filter((entry) => entry.expiresAt > Date.now());
  state.health = health ?? {};
  for (const node of state.nodes) {
    const snapshot = state.health[node.id];
    if (!snapshot) continue;
    // Trust state always wins over telemetry. Health can never activate a
    // pending connection or restore an administrator's suspended connection.
    if (node.status === "pending" || node.status === "suspended") {
      snapshot.status = node.status;
    } else if (
      snapshot.status !== "pending" &&
      snapshot.status !== "suspended"
    ) {
      node.status = snapshot.status;
    }
    node.lastSeenAt = snapshot.lastSuccessfulAt ?? node.lastSeenAt;
    node.lastError = snapshot.error;
  }
  return state;
}

export function getFleetState() {
  return serialized(loadState);
}

export function recordFleetHealth(snapshot: FleetHealthSnapshot) {
  return serialized(async () => {
    const state = await loadState();
    const node = state.nodes.find((item) => item.id === snapshot.serverId);
    if (snapshot.serverId === "local") {
      state.health.local = snapshot;
      await healthStore.save(state.health);
      return snapshot;
    }
    if (!node) return;
    const previous = state.health[node.id];
    if (
      previous &&
      Date.parse(previous.checkedAt) > Date.parse(snapshot.checkedAt)
    )
      return;
    const next = {
      ...snapshot,
      label: node.node.label,
      origin: node.node.origin,
      lastSuccessfulAt:
        Date.parse(previous?.lastSuccessfulAt ?? "") >
        Date.parse(snapshot.lastSuccessfulAt ?? "1970-01-01")
          ? previous?.lastSuccessfulAt
          : snapshot.lastSuccessfulAt,
      status:
        node.status === "pending" || node.status === "suspended"
          ? node.status
          : snapshot.status,
    };
    state.health[node.id] = next;
    await healthStore.save(state.health);
    return next;
  });
}

export function revokeFleetAuthorizations(user: {
  id: string;
  username: string;
}) {
  return mutateFleetState((state) => {
    const before = state.nodeLinks.length;
    state.nodeLinks = state.nodeLinks.filter(
      (link) =>
        link.owner.id !== user.id &&
        link.owner.username.toLowerCase() !== user.username.toLowerCase(),
    );
    state.invitations = state.invitations.filter(
      (item) =>
        item.createdBy.id !== user.id &&
        item.createdBy.username.toLowerCase() !== user.username.toLowerCase(),
    );
    return state.nodeLinks.length !== before;
  });
}

export function mutateFleetState<T>(
  mutation: (state: FleetState) => T | Promise<T>,
) {
  return serialized(async () => {
    const state = await loadState();
    const previousHealth = JSON.stringify(state.health);
    const previousReplays = JSON.stringify(state.replays);
    const result = await mutation(state);
    if (JSON.stringify(state.health) !== previousHealth)
      await healthStore.save(state.health);
    if (JSON.stringify(state.replays) !== previousReplays)
      await replayStore.save(state.replays);
    await store.save({ ...state, health: {}, replays: [] });
    return result;
  });
}

export function fleetSecret(length = 32) {
  return randomBytes(length).toString("base64url");
}

export function hashFleetSecret(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function matchesFleetSecret(value: string, expected: string) {
  const actual = Buffer.from(hashFleetSecret(value), "hex");
  const wanted = Buffer.from(expected, "hex");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export async function consumeReplay(connectionId: string, requestId: string) {
  return serialized(async () => {
    const state = await loadState();
    if (
      state.replays.some(
        (item) =>
          item.connectionId === connectionId && item.requestId === requestId,
      )
    )
      return false;
    state.replays.push({
      connectionId,
      requestId,
      expiresAt: Date.now() + 5 * 60_000,
    });
    await replayStore.save(state.replays);
    return true;
  });
}
