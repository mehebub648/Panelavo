import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSiteRootOverride,
  removeSiteRootOverride,
  setSiteRootOverride,
} from "./site-root-overlay";

describe("site root overlay", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "site-roots-"));
    process.env.PANEL_DATA_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.PANEL_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it("stores and removes roots case-insensitively", async () => {
    await setSiteRootOverride("App.Example.COM", "app.example.com");
    expect(await getSiteRootOverride("app.example.com")).toBe(
      "app.example.com",
    );
    await removeSiteRootOverride("APP.EXAMPLE.COM");
    expect(await getSiteRootOverride("app.example.com")).toBeUndefined();
  });

  it("survives a corrupt store file", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "site-roots.json"), "not json");
    expect(await getSiteRootOverride("app.example.com")).toBeUndefined();
  });
});
