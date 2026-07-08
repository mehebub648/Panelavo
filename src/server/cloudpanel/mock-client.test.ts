import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "./errors";
import { MockCloudPanelClient, resetMockSites } from "./mock-client";

describe("MockCloudPanelClient", () => {
  const client = new MockCloudPanelClient();
  beforeEach(() => resetMockSites());

  it("authenticates a valid CloudPanel account without returning a password", async () => {
    const result = await client.login({
      username: "admin",
      password: "admin123",
    });
    expect(result.status).toBe("authenticated");
    expect(JSON.stringify(result)).not.toContain("admin123");
  });

  it("rejects invalid credentials", async () => {
    await expect(
      client.login({ username: "admin", password: "wrong" }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("requires and validates two-factor authentication", async () => {
    const challenge = await client.login({
      username: "mfa",
      password: "mfa123",
    });
    expect(challenge.status).toBe("two-factor-required");
    if (challenge.status !== "two-factor-required") throw new Error();
    await expect(
      client.verifyTwoFactor({ session: challenge.session, code: "000000" }),
    ).rejects.toMatchObject({ code: "INVALID_TWO_FACTOR_CODE" });
    await expect(
      client.verifyTwoFactor({ session: challenge.session, code: "123456" }),
    ).resolves.toMatchObject({ status: "authenticated" });
  });

  it("returns only assigned sites for a restricted user", async () => {
    const login = await client.login({ username: "user", password: "user123" });
    if (login.status !== "authenticated") throw new Error();
    const sites = await client.listSites(login.session);
    expect(sites.map((site) => site.domain)).toEqual(["api.harbor.dev"]);
  });

  it("enforces create permission server-side", async () => {
    const login = await client.login({ username: "user", password: "user123" });
    if (login.status !== "authenticated") throw new Error();
    await expect(
      client.createSite(login.session, {
        type: "static",
        domain: "new.example",
        siteUser: "new-example",
        siteUserPassword: "LongPassword!123",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("creates a site and rejects a duplicate", async () => {
    const login = await client.login({
      username: "admin",
      password: "admin123",
    });
    if (login.status !== "authenticated") throw new Error();
    const input = {
      type: "static" as const,
      domain: "new.example",
      siteUser: "new-example",
      siteUserPassword: "LongPassword!123",
    };
    await expect(
      client.createSite(login.session, input),
    ).resolves.toMatchObject({ domain: "new.example" });
    await expect(client.createSite(login.session, input)).rejects.toMatchObject(
      { code: "DOMAIN_ALREADY_EXISTS" },
    );
  });

  it("rejects expired or unknown sessions", async () => {
    await expect(client.listSites({ cookies: {} })).rejects.toEqual(
      expect.objectContaining<Partial<AppError>>({ code: "SESSION_EXPIRED" }),
    );
  });

  it("rejects unsupported runtime versions", async () => {
    const login = await client.login({
      username: "admin",
      password: "admin123",
    });
    if (login.status !== "authenticated") throw new Error();
    await expect(
      client.createSite(login.session, {
        type: "nodejs",
        domain: "node.example",
        nodeVersion: "999",
        appPort: 3000,
        siteUser: "node-example",
        siteUserPassword: "LongPassword!123",
      }),
    ).rejects.toMatchObject({ code: "INVALID_RUNTIME_VERSION" });
  });
});
