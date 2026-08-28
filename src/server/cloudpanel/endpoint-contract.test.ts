import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("project endpoint broker contract", () => {
  it("allows a reserved listener only after verifying parent-project ownership", async () => {
    const bridge = await readFile(
      join(process.cwd(), "scripts", "cloudpanel-bridge.php"),
      "utf8",
    );

    expect(bridge).toContain("isset($input['endpointParentDomain'])");
    expect(bridge).toContain("manageSiteEndpoint($manager, $parent");
    expect(bridge).toContain(
      "'endpointDomain' => strtolower((string) $site->getDomainName())",
    );
    expect(bridge).toContain("&& !$verifiedEndpointPort");
  });
});
