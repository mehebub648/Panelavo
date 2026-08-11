import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLabelsForSites, getSiteLabel, removeSiteLabel, setSiteLabel } from "./site-labels";

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "panelavo-labels-"));
  process.env.PANEL_DATA_DIR = directory;
});
afterEach(async () => {
  delete process.env.PANEL_DATA_DIR;
  await rm(directory, { recursive: true, force: true });
});

describe("site labels", () => {
  it("matches both normalized domain and current upstream site id", async () => {
    await setSiteLabel("Example.COM", "old-id", "Old application");
    expect(await getSiteLabel("example.com", "old-id")).toBe("Old application");
    expect(await getSiteLabel("example.com", "new-id")).toBeUndefined();
    expect(
      await getLabelsForSites([
        { id: "new-id", domain: "example.com", url: "https://example.com" },
      ]),
    ).toEqual({});
  });

  it("removes labels on explicit deletion or an empty update", async () => {
    await setSiteLabel("example.com", "id-1", "API");
    await setSiteLabel("example.com", "id-1", "");
    expect(await getSiteLabel("example.com", "id-1")).toBeUndefined();
    await setSiteLabel("example.com", "id-1", "API");
    await removeSiteLabel("EXAMPLE.COM");
    expect(await getSiteLabel("example.com", "id-1")).toBeUndefined();
    expect(JSON.parse(await readFile(join(directory, "site-labels.json"), "utf8"))).toEqual({ labels: {} });
  });
});
