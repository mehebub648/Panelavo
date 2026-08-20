import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("resource collector source contract", () => {
  it("keeps website attribution conservative and every slow scan bounded", async () => {
    const source = await readFile(
      join(process.cwd(), "scripts", "cloudpanel-bridge.php"),
      "utf8",
    );

    expect(source).toContain("/smaps_rollup");
    expect(source).toContain("resourceContainerSites($sites, $processes)");
    expect(source).toContain("addResourceProcess($shared, $process)");
    expect(source).toContain("addResourceProcess($system, $process)");
    expect(source).toContain("$scanRoots), 3)");
    expect(source).not.toContain("timeout 10 du -sb --one-file-system");
    expect(source).not.toContain("/tmp/.panelavo-du-cache.json");
  });
});
