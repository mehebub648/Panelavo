import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureResourceSampler, getResourceHistory } from "./resource-history";

describe("resource history sampler", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "resource-history-"));
    process.env.PANEL_DATA_DIR = dir;
  });

  afterAll(async () => {
    delete process.env.PANEL_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it("collects an initial sample with sane percentages", async () => {
    await ensureResourceSampler();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const points = await getResourceHistory();
    expect(points.length).toBeGreaterThanOrEqual(1);
    const point = points[points.length - 1];
    expect(point.t).toBeGreaterThan(Date.now() - 60_000);
    for (const value of [point.cpu, point.mem, point.disk]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });
});
