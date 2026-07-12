import { describe, expect, it, vi } from "vitest";
import {
  getReadiness,
  hasRequiredProductionConfiguration,
} from "./readiness";

describe("hasRequiredProductionConfiguration", () => {
  it("requires separate production secrets of at least 32 characters", () => {
    expect(
      hasRequiredProductionConfiguration({
        NODE_ENV: "production",
        SESSION_SECRET: "s".repeat(32),
        CREDENTIALS_ENCRYPTION_KEY: "e".repeat(32),
      }),
    ).toBe(true);
    expect(
      hasRequiredProductionConfiguration({
        NODE_ENV: "production",
        SESSION_SECRET: "short",
        CREDENTIALS_ENCRYPTION_KEY: "e".repeat(32),
      }),
    ).toBe(false);
    expect(
      hasRequiredProductionConfiguration({
        NODE_ENV: "production",
        SESSION_SECRET: "x".repeat(32),
        CREDENTIALS_ENCRYPTION_KEY: "x".repeat(32),
      }),
    ).toBe(false);
  });

  it("does not require production secrets in development or tests", () => {
    expect(hasRequiredProductionConfiguration({ NODE_ENV: "test" })).toBe(
      true,
    );
  });
});

describe("getReadiness", () => {
  const productionEnv = {
    NODE_ENV: "production" as const,
    SESSION_SECRET: "s".repeat(32),
    CREDENTIALS_ENCRYPTION_KEY: "e".repeat(32),
  };

  it("is ready only when configuration and the CloudPanel broker pass", async () => {
    const checkDependency = vi.fn().mockResolvedValue(undefined);
    await expect(
      getReadiness({ env: productionEnv, checkDependency }),
    ).resolves.toEqual({
      ready: true,
      checks: { configuration: "pass", cloudPanel: "pass" },
    });
    expect(checkDependency).toHaveBeenCalledOnce();
  });

  it("fails closed without disclosing a dependency error", async () => {
    const checkDependency = vi
      .fn()
      .mockRejectedValue(new Error("sensitive broker stderr"));
    const result = await getReadiness({
      env: productionEnv,
      checkDependency,
    });
    expect(result).toEqual({
      ready: false,
      checks: { configuration: "pass", cloudPanel: "fail" },
    });
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });

  it("still probes the dependency when configuration is invalid", async () => {
    const checkDependency = vi.fn().mockResolvedValue(undefined);
    await expect(
      getReadiness({
        env: { NODE_ENV: "production" },
        checkDependency,
      }),
    ).resolves.toEqual({
      ready: false,
      checks: { configuration: "fail", cloudPanel: "pass" },
    });
  });
});
