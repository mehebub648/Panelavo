import { describe, expect, it } from "vitest";
import { createSiteSchema, normalizeDomain } from "./sites";

const shared = {
  type: "static" as const,
  domain: "example.com",
  siteUser: "example",
  siteUserPassword: "LongPassword!123",
};

describe("site validation", () => {
  it("normalizes a safe domain", () => {
    expect(normalizeDomain(" HTTPS://Example.COM. ")).toBe("example.com");
    expect(
      createSiteSchema.parse({ ...shared, domain: "Example.COM" }).domain,
    ).toBe("example.com");
  });

  it.each([
    "bad domain.com",
    "example.com/path",
    "example.com?x=1",
    "example.com:443",
    "*.example.com",
    "example.com\n--flag",
    "example.com;id",
  ])('rejects unsafe domain "%s"', (domain) => {
    expect(createSiteSchema.safeParse({ ...shared, domain }).success).toBe(
      false,
    );
  });

  it("rejects raw command fields", () => {
    expect(
      createSiteSchema.safeParse({ ...shared, command: "id" }).success,
    ).toBe(false);
  });

  it("validates application ports", () => {
    const input = { ...shared, type: "nodejs", nodeVersion: "22", appPort: 22 };
    expect(createSiteSchema.safeParse(input).success).toBe(false);
    expect(
      createSiteSchema.safeParse({ ...input, appPort: 3000 }).success,
    ).toBe(true);
  });

  it.each([
    "ftp://127.0.0.1",
    "http://user:pass@host",
    "http://127.0.0.1\ninclude /etc/passwd",
    "not a url",
  ])('rejects unsafe proxy URL "%s"', (reverseProxyUrl) => {
    expect(
      createSiteSchema.safeParse({
        ...shared,
        type: "reverse-proxy",
        reverseProxyUrl,
      }).success,
    ).toBe(false);
  });
});
