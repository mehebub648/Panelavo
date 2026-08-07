import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDeployHooks, setDeployHooks } from "./hooks";

describe("deploy hooks", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "panelavo-deploy-hooks-"));
    process.env.PANEL_DATA_DIR = directory;
  });
  afterEach(async () => {
    delete process.env.PANEL_DATA_DIR;
    await rm(directory, { recursive: true, force: true });
  });
  it("preserves the validated operation order", async () => {
    const hooks = [
      { command: "npm-ci" },
      { command: "npm-run", script: "build" },
      { command: "pm2-restart" },
    ] as const;
    await setDeployHooks("Example.com", hooks);
    await expect(getDeployHooks("example.COM")).resolves.toEqual(hooks);
  });
  it("rejects destructive or free-form commands", async () => {
    await expect(
      setDeployHooks("example.com", [{ command: "compose-down" }]),
    ).rejects.toThrow();
  });
});
