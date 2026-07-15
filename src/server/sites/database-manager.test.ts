import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getConfiguredDatabaseManagerUrl,
  isDatabaseManagerDomain,
} from "./database-manager";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("database manager detection", () => {
  it("normalizes the configured URL to its origin", () => {
    vi.stubEnv(
      "DATABASE_MANAGER_URL",
      "https://database.1.2.3.4.example.com/index.php",
    );
    expect(getConfiguredDatabaseManagerUrl()).toBe(
      "https://database.1.2.3.4.example.com",
    );
  });

  it("rejects malformed or non-http values", () => {
    vi.stubEnv("DATABASE_MANAGER_URL", "not a url");
    expect(getConfiguredDatabaseManagerUrl()).toBeNull();
    vi.stubEnv("DATABASE_MANAGER_URL", "javascript:alert(1)");
    expect(getConfiguredDatabaseManagerUrl()).toBeNull();
  });

  it("protects exactly the configured host, case-insensitively", () => {
    vi.stubEnv(
      "DATABASE_MANAGER_URL",
      "https://database.1.2.3.4.example.com",
    );
    expect(isDatabaseManagerDomain("Database.1.2.3.4.Example.com")).toBe(true);
    expect(isDatabaseManagerDomain("site-20001.1.2.3.4.example.com")).toBe(
      false,
    );
  });

  it("protects nothing when no manager is configured", () => {
    expect(isDatabaseManagerDomain("database.1.2.3.4.example.com")).toBe(
      false,
    );
  });
});
