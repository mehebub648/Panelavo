import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  planSiteSsl: vi.fn(),
  issueSiteSsl: vi.fn(),
}));

vi.mock("./ensure-ssl", () => mocks);

import { secureCreatedSite } from "./initial-site-ssl";

const session = { cookies: {}, usernameHint: "admin" };
const input = {
  userId: "1",
  systemDomain: "site-23000.example.test",
  aliases: ["example.test"],
  serverIp: "192.0.2.10",
};

describe("secureCreatedSite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.planSiteSsl.mockResolvedValue({
      san: ["example.test"],
      warnings: ["www.example.test is not pointed yet."],
    });
    mocks.issueSiteSsl.mockResolvedValue(undefined);
  });

  it("waits for issuance and returns DNS warnings", async () => {
    let finishIssuance!: () => void;
    mocks.issueSiteSsl.mockImplementation(
      () => new Promise<void>((resolve) => (finishIssuance = resolve)),
    );
    let settled = false;
    const result = secureCreatedSite(session, input).then((warnings) => {
      settled = true;
      return warnings;
    });

    await vi.waitFor(() => expect(mocks.issueSiteSsl).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    finishIssuance();

    await expect(result).resolves.toEqual([
      "www.example.test is not pointed yet.",
    ]);
  });

  it("keeps the created site successful and gives a retry action on failure", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.issueSiteSsl.mockRejectedValue(new Error("ACME failed"));

    const warnings = await secureCreatedSite(session, input);

    expect(warnings).toContain("www.example.test is not pointed yet.");
    expect(warnings.at(-1)).toContain('use "Issue Let\'s Encrypt" to retry');
    expect(errorLog).toHaveBeenCalledOnce();
  });
});
