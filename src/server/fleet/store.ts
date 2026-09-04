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
  mode: FleetMode;
  localNodeId: string;
  hub?: { id: string; label: string; origin: string; enabledAt: string };
  nodeLink?: FleetNodeLink;
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
  invitations: [],
  replays: [],
  health: {},
  rollingUpdates: [],
}));
let mutationQueue: Promise<unknown> = Promise.resolve();

function clean(state: FleetState) {
  const now = Date.now();
  state.invitations = state.invitations.filter(
    (item) => Date.parse(item.expiresAt) > now,
  );
  state.replays = state.replays.filter((item) => item.expiresAt > now);
  state.rollingUpdates = state.rollingUpdates.slice(-25);
  return state;
}

export async function getFleetState() {
  return clean(await store.load());
}

export function mutateFleetState<T>(
  mutation: (state: FleetState) => T | Promise<T>,
) {
  const operation = mutationQueue.then(async () => {
    const state = clean(await store.load());
    const result = await mutation(state);
    await store.save(state);
    return result;
  });
  mutationQueue = operation.catch(() => undefined);
  return operation;
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
  return mutateFleetState((state) => {
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
    return true;
  });
}
