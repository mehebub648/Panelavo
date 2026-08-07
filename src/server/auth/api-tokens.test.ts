import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiToken, listApiTokens, revokeApiToken } from "./api-tokens";

describe("API tokens", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "panelavo-api-tokens-"));
    process.env.PANEL_DATA_DIR = directory;
    process.env.SESSION_SECRET =
      "test-session-secret-with-at-least-32-characters";
  });
  afterEach(async () => {
    delete process.env.PANEL_DATA_DIR;
    delete process.env.SESSION_SECRET;
    await rm(directory, { recursive: true, force: true });
  });
  it("shows the secret once and persists only public metadata", async () => {
    const created = await createApiToken("admin", {
      name: "CI",
      scopes: ["sites:read"],
      expiresInDays: 30,
    });
    expect(created.token).toMatch(/^pnl_/);
    await expect(listApiTokens("admin")).resolves.toEqual([created.record]);
    await revokeApiToken("admin", created.record.id);
    await expect(listApiTokens("admin")).resolves.toEqual([]);
  });
});
