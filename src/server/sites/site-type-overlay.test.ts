import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSiteTypeOverrides,
  isSiteActionAllowed,
  removeSiteTypeOverride,
  setSiteTypeOverride,
} from "./site-type-overlay";

describe("site type overlay", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "site-types-"));
    process.env.PANEL_DATA_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.PANEL_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it("starts empty and stores overrides case-insensitively", async () => {
    expect(await getSiteTypeOverrides()).toEqual({});
    await setSiteTypeOverride("App.Example.COM", "docker");
    expect(await getSiteTypeOverrides()).toEqual({ "app.example.com": "docker" });
  });

  it("removes overrides and tolerates removing missing ones", async () => {
    await setSiteTypeOverride("a.test", "docker");
    await removeSiteTypeOverride("A.TEST");
    await removeSiteTypeOverride("never-existed.test");
    expect(await getSiteTypeOverrides()).toEqual({});
  });

  it("survives a corrupt store file", async () => {
    await setSiteTypeOverride("a.test", "docker");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "site-types.json"), "not json");
    expect(await getSiteTypeOverrides()).toEqual({});
    await setSiteTypeOverride("b.test", "docker");
    expect(await getSiteTypeOverrides()).toEqual({ "b.test": "docker" });
  });

  it("limits explicit Docker sites to Compose operations", () => {
    expect(isSiteActionAllowed("docker", "compose-up")).toBe(true);
    expect(isSiteActionAllowed("docker", "npm-install")).toBe(false);
    expect(isSiteActionAllowed("nodejs", "npm-install")).toBe(true);
  });
});
