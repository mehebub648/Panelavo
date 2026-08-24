import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("selective LanceDB broker contract", () => {
  it("keeps containment, quiesce, checksum, ownership, validation, and rollback guards together", async () => {
    const source = await readFile(
      join(process.cwd(), "scripts", "cloudpanel-bridge.php"),
      "utf8",
    );

    expect(source).toContain("function lanceDatastoreDirectory(");
    expect(source).toContain("The LanceDB path cannot contain symbolic links");
    expect(source).toContain("function selectLanceTables(");
    expect(source).toContain("resolveOperationStep($state, 'compose-down'");
    expect(source).toContain("resolveOperationStep($state, 'compose-up'");
    expect(source).toContain("hash_file('sha256', $archive)");
    expect(source).toContain("function inspectLanceSnapshotArchive(");
    expect(source).toContain("Datastore snapshots reject links and special filesystem entries");
    expect(source).toContain("function prepareLanceRestoreOwnership(");
    expect(source).toContain("subordinateRange('/etc/subuid'");
    expect(source).toContain("d:u:' . $identity['user'] . ':rwx");
    expect(source).toContain("foreach (array_reverse($rollback)");
    expect(source).toContain("function lanceDataChecks(");
  });
});
