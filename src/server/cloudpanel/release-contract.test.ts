import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("managed artifact release broker contract", () => {
  it("keeps staging, activation, health, rollback, and storage guards together", async () => {
    const source = await readFile(
      join(process.cwd(), "scripts", "cloudpanel-bridge.php"),
      "utf8",
    );

    expect(source).toContain("function validatePanelavoArtifact(");
    expect(source).toContain("hash_file('sha256', $real)");
    expect(source).toContain("PANELAVO_CALLER_UID");
    expect(source).toContain("function inspectReleaseArchive(");
    expect(source).toContain("Managed releases reject archive links");
    expect(source).toContain("function assertReleaseRootHasNoMounts(");
    expect(source).toContain("function switchManagedRelease(");
    expect(source).toContain("function runManagedReleasePlan(");
    expect(source).toContain("switchManagedRelease($paths['root'], $previous)");
    expect(source).toContain("retainManagedReleases($paths, $destination)");
    expect(source).toContain("'https://' . $domain . $healthPath");
    expect(source).toContain("/^(node|static-build|php|python)$/");
  });
});
