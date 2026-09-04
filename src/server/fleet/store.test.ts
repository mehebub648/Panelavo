import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
