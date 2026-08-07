import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jsonStore } from "./json-store";

describe("jsonStore", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "panelavo-json-store-"));
    process.env.PANEL_DATA_DIR = directory;
  });

  afterEach(async () => {
    delete process.env.PANEL_DATA_DIR;
    await rm(directory, { recursive: true, force: true });
  });

  it("round-trips normalized values and falls back for invalid JSON", async () => {
    const store = jsonStore(
      "settings.json",
      () => ({ count: 0 }),
      (value) => ({ count: Number((value as { count?: unknown }).count) }),
    );

    await store.save({ count: 4 });
    expect(await store.load()).toEqual({ count: 4 });

    await writeFile(join(directory, "settings.json"), "not json", "utf8");
    expect(await store.load()).toEqual({ count: 0 });
  });

  it("publishes only complete files when saves overlap", async () => {
    const store = jsonStore("state.json", () => ({ value: -1 }));
    await Promise.all(
      Array.from({ length: 12 }, (_, value) => store.save({ value })),
    );

    const persisted = JSON.parse(
      await readFile(join(directory, "state.json"), "utf8"),
    ) as { value: number };
    expect(persisted.value).toBeGreaterThanOrEqual(0);
    expect(persisted.value).toBeLessThan(12);
    expect(
      (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });
});
