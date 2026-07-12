import { describe, expect, it } from "vitest";
import {
  createLinkedServiceSchema,
  createSiteSchema,
  normalizeDomain,
  updateSiteSchema,
} from "./sites";

const shared = {
  type: "static" as const,
  category: "client",
  siteUserPassword: "LongPassword!123",
};

describe("site validation", () => {
  it("normalizes safe alias domains", () => {
    expect(normalizeDomain(" HTTPS://Example.COM. ")).toBe("example.com");
    expect(
      createSiteSchema.parse({ ...shared, aliases: ["Example.COM"] }).aliases,
    ).toEqual(["example.com"]);
  });

  it("defaults to no aliases", () => {
    expect(createSiteSchema.parse(shared).aliases).toEqual([]);
  });

  it.each([
    "bad domain.com",
    "example.com/path",
    "example.com?x=1",
    "example.com:443",
    "*.example.com",
    "example.com\n--flag",
    "example.com;id",
  ])('rejects unsafe alias domain "%s"', (alias) => {
    expect(
      createSiteSchema.safeParse({ ...shared, aliases: [alias] }).success,
    ).toBe(false);
  });

  it("rejects raw command fields and unknown categories", () => {
    expect(
      createSiteSchema.safeParse({ ...shared, command: "id" }).success,
    ).toBe(false);
    expect(
      createSiteSchema.safeParse({ ...shared, category: "x; rm -rf /" })
        .success,
    ).toBe(false);
  });

  it("no longer accepts caller-chosen domains, users, or ports", () => {
    expect(
      createSiteSchema.safeParse({ ...shared, domain: "example.com" }).success,
    ).toBe(false);
    expect(
      createSiteSchema.safeParse({ ...shared, siteUser: "hacker" }).success,
    ).toBe(false);
    expect(
      createSiteSchema.safeParse({
        ...shared,
        type: "nodejs",
        nodeVersion: "22",
        appPort: 3000,
      }).success,
    ).toBe(false);
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

  it("allows Panelavo to derive a reverse-proxy target from the reserved site id", () => {
    expect(
      createSiteSchema.safeParse({
        ...shared,
        type: "reverse-proxy",
      }).success,
    ).toBe(true);
  });

  it("accepts a linked service with a safe name and port", () => {
    const parsed = createLinkedServiceSchema.parse({
      serviceName: "API",
      targetPort: "20001",
      aliases: ["Api.Example.COM"],
    });
    expect(parsed).toEqual({
      serviceName: "api",
      targetPort: 20001,
      aliases: ["api.example.com"],
    });
  });

  it.each([
    { serviceName: "bad name", targetPort: 20001 },
    { serviceName: "api;id", targetPort: 20001 },
    { serviceName: "9api", targetPort: 20001 },
    { serviceName: "api", targetPort: 80 },
    { serviceName: "api", targetPort: 70000 },
    { serviceName: "api", targetPort: 20001, domain: "attacker.com" },
  ])("rejects unsafe linked-service input %j", (input) => {
    expect(createLinkedServiceSchema.safeParse(input).success).toBe(false);
  });

  it("keeps updated document roots inside the website htdocs directory", () => {
    expect(
      updateSiteSchema.safeParse({ rootDirectory: "public" }).success,
    ).toBe(true);
    expect(
      updateSiteSchema.safeParse({ rootDirectory: "apps/web/public" }).success,
    ).toBe(true);
    expect(
      updateSiteSchema.safeParse({ rootDirectory: "../../etc" }).success,
    ).toBe(false);
    expect(
      updateSiteSchema.safeParse({ rootDirectory: "app/../secret" }).success,
    ).toBe(false);
  });
});
