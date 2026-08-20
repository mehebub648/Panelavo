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
    expect(source).toContain(
      "function serverStorage($manager, bool $refresh = false)",
    );
    expect(source).toContain("resourceDirectoryUsage($paths)");
    expect(source).toContain("'/usr/bin/ionice', '-c', '3'");
    expect(source).toContain("array_slice($paths, 0, 32)");
    expect(source).toContain("'Filesystem overhead and unclassified data'");
    expect(source).toContain("pathIsSocket($socket)");
    expect(source).toContain("'DOCKER_HOST=unix://' . $socket");
    expect(source).toContain("'/usr/bin/sudo', '-n', '-u', $user");
    expect(source).toContain("resource-storage.lock");
  });
});
