import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptedJsonStore } from "@/server/storage/encrypted-json-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumeReplay,
  fleetSecret,
  getFleetState,
  mutateFleetState,
} from "./store";

describe("Fleet encrypted persistent state", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "panelavo-fleet-"));
    process.env.PANEL_DATA_DIR = directory;
    process.env.SESSION_SECRET =
      "fleet-test-session-secret-at-least-32-characters";
  });
  afterEach(async () => {
    delete process.env.PANEL_DATA_DIR;
    delete process.env.SESSION_SECRET;
    await rm(directory, { recursive: true, force: true });
  });

  it("encrypts private state and persists replay identifiers", async () => {
    const secret = fleetSecret();
    await mutateFleetState((state) => {
      state.mode = "hub";
      state.hub = {
        id: "hub",
        label: secret,
        origin: "https://panel.example.com",
        enabledAt: new Date().toISOString(),
      };
    });
    const stored = await readFile(
      join(directory, "fleet-state.enc.json"),
      "utf8",
    );
    expect(stored).not.toContain(secret);
    expect(await consumeReplay("connection", "request")).toBe(true);
    expect(await consumeReplay("connection", "request")).toBe(false);
    expect((await getFleetState()).mode).toBe("hub");
  });

  it("persists one identity on a fresh installation", async () => {
    expect((await getFleetState()).localNodeId).toBe(
      (await getFleetState()).localNodeId,
    );
  });

  it("migrates single-manager trust without changing ids or key material", async () => {
    const oldLink = {
      connectionId: "existing",
      owner: { id: "owner", username: "owner" },
      nodePrivateKey: "private-test-material",
    };
    const previous = encryptedJsonStore("fleet-state.enc.json", () => ({}));
    await previous.save({
      version: 1,
      mode: "node",
      localNodeId: "stable",
      nodeLink: oldLink,
      nodes: [],
      invitations: [],
      replays: [],
      health: {},
      rollingUpdates: [],
    });
    const migrated = await getFleetState();
    expect(migrated.localNodeId).toBe("stable");
    expect(migrated.nodeLinks).toEqual([oldLink]);
    expect(migrated.nodeLink).toBeUndefined();
    await mutateFleetState(() => undefined);
    expect((await getFleetState()).nodeLinks).toEqual([oldLink]);
  });
});
