import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("controlled recovery broker contract", () => {
  it("keeps MCP recovery on exact existing primitives", async () => {
    const source = await readFile(
      join(process.cwd(), "scripts", "cloudpanel-bridge.php"),
      "utf8",
    );

    expect(source).toContain("function manageSiteRecovery(");
    expect(source).toContain("resolveOperationStep($state, 'upstream-check'");
    expect(source).toContain("ensureSiteProjectAccess($site)");
    expect(source).toContain("executeFix($site, 'initialize-rootless-runtime'");
    expect(source).toContain("recoverRootlessMigration($site)");
    expect(source).toContain("$user->getRole() !== User::ROLE_ADMIN");
    expect(source).toContain("['repair-site-acl', 'restart-rootless-runtime', 'recover-rootless-migration']");
  });
});
