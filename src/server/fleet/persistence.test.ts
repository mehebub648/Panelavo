import { mkdtemp, readFile, rm, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encryptedJsonStore } from "@/server/storage/encrypted-json-store";
import {
  consumeReplay,
  getFleetState,
  mutateFleetState,
  recordFleetHealth,
} from "./store";
import type { FleetConnection, FleetHealthSnapshot } from "./types";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rename: vi.fn(fs.rename) };
});
let directory: string;
const connection = {
  id: "node",
  status: "online",
  node: { label: "Node", origin: "https://node.example.com" },
  hubPrivateKey: "private-key-material",
} as FleetConnection;
const health = (
  status: FleetHealthSnapshot["status"] = "online",
): FleetHealthSnapshot => ({
  serverId: "node",
  label: "Node",
  origin: "https://node.example.com",
  status,
  checkedAt: new Date().toISOString(),
  ...(status === "online"
    ? { lastSuccessfulAt: new Date().toISOString() }
    : { error: "offline" }),
});
const contents = (name: string) => readFile(join(directory, name), "utf8");
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "panelavo-fleet-persistence-"));
  vi.stubEnv("PANEL_DATA_DIR", directory);
  vi.stubEnv(
    "SESSION_SECRET",
    "test-fleet-persistence-secret-at-least-32-characters",
  );
  await mutateFleetState((state) => {
    state.nodes = [structuredClone(connection)];
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

it("keeps trust bytes unchanged during health updates and durable replay checks", async () => {
  const trust = await contents("fleet-state.enc.json");
  await recordFleetHealth(health());
  const healthBytes = await contents("fleet-health.enc.json");
  expect(await consumeReplay("node", "once")).toBe(true);
  const replayBytes = await contents("fleet-replays.enc.json");
  expect(await consumeReplay("node", "once")).toBe(false);
  expect(await contents("fleet-state.enc.json")).toBe(trust);
  expect(await contents("fleet-health.enc.json")).toBe(healthBytes);
  expect(await contents("fleet-replays.enc.json")).toBe(replayBytes);
  expect(healthBytes + replayBytes).not.toContain("private-key-material");
  expect(replayBytes).not.toContain("once");
  vi.resetModules();
  expect(await (await import("./store")).consumeReplay("node", "once")).toBe(
    false,
  );
});

it("accepts simultaneous identical requests exactly once", async () => {
  const accepted = await Promise.all(
    Array.from({ length: 8 }, () => consumeReplay("node", "same")),
  );
  expect(accepted.filter(Boolean)).toHaveLength(1);
});

it("fails closed when replay storage is missing, corrupt, or cannot save", async () => {
  vi.mocked(rename).mockRejectedValueOnce(new Error("disk full"));
  await expect(consumeReplay("node", "retry")).rejects.toThrow("disk full");
  expect(await consumeReplay("node", "retry")).toBe(true);
  await writeFile(join(directory, "fleet-replays.enc.json"), "broken");
  await expect(consumeReplay("node", "bad")).rejects.toThrow();
  await rm(join(directory, "fleet-replays.enc.json"));
  await expect(consumeReplay("node", "missing")).rejects.toThrow(
    /replay protection is missing/,
  );
});

it("repeats interrupted migration without forgetting old or newly stored nonces", async () => {
  const state = await getFleetState();
  delete state.splitPersistence;
  state.replays = [
    {
      connectionId: "node",
      requestId: "legacy",
      expiresAt: Date.now() + 60_000,
    },
  ];
  state.health.node = health();
  await encryptedJsonStore("fleet-state.enc.json", () => state).save(state);
  await encryptedJsonStore("fleet-replays.enc.json", () => []).save([
    { connectionId: "node", requestId: "new", expiresAt: Date.now() + 60_000 },
  ] as never[]);
  expect(await consumeReplay("node", "legacy")).toBe(false);
  expect(await consumeReplay("node", "new")).toBe(false);
  const migrated = await getFleetState();
  expect(migrated.localNodeId).toBe(state.localNodeId);
  expect(migrated.nodes[0].hubPrivateKey).toBe(connection.hubPrivateKey);
  expect(migrated.health.node.status).toBe("online");
});

it.each(["suspended", "pending"] as const)(
  "never lets health reactivate a %s node",
  async (status) => {
    await mutateFleetState((state) => {
      state.nodes[0].status = status;
    });
    await recordFleetHealth(health());
    expect((await getFleetState()).nodes[0].status).toBe(status);
    expect((await getFleetState()).health.node.status).toBe(status);
  },
);

it("ignores old observations and late results for a removed connection", async () => {
  const latest = health();
  await recordFleetHealth(latest);
  await recordFleetHealth({
    ...health("offline"),
    checkedAt: new Date(0).toISOString(),
  });
  expect((await getFleetState()).health.node.status).toBe("online");
  await mutateFleetState((state) => {
    state.nodes = [];
    delete state.health.node;
  });
  await recordFleetHealth(health());
  expect((await getFleetState()).health.node).toBeUndefined();
});

it("retains last success on failure and persists telemetry separately from configuration edits", async () => {
  const online = health();
  await recordFleetHealth(online);
  await recordFleetHealth(health("offline"));
  await mutateFleetState((state) => {
    state.nodes[0].node.label = "Renamed";
  });
  const state = await getFleetState();
  expect(state.nodes[0].node.label).toBe("Renamed");
  expect(state.nodes[0].status).toBe("offline");
  expect(state.nodes[0].lastSeenAt).toBe(online.lastSuccessfulAt);
});
