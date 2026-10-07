import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  autoPointDns: vi.fn(),
  resolveDnsOriginStatus: vi.fn(),
  getSiteSection: vi.fn(),
  manageSiteSection: vi.fn(),
}));

vi.mock("@/server/cloudpanel", () => ({ getCloudPanelClient: () => mocks }));

vi.mock("@/server/network/auto-dns", () => ({
  autoPointDns: mocks.autoPointDns,
}));
vi.mock("@/server/network/dns-origin", () => ({
  resolveDnsOriginStatus: mocks.resolveDnsOriginStatus,
}));

import {
  certificateAlreadyCovers,
  issueSiteSsl,
  planSiteSsl,
} from "./ensure-ssl";
import type { CloudPanelSession } from "@/types/cloudpanel";

describe("site SSL planning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.autoPointDns.mockResolvedValue({ changed: false });
    mocks.resolveDnsOriginStatus.mockResolvedValue([
      {
        name: "example.com",
        ip: "203.0.113.10",
        ips: ["203.0.113.10"],
        publicIps: ["203.0.113.10"],
        publicResolved: true,
        managed: false,
        originVerified: true,
        proxied: false,
        chain: ["example.com"],
        pointed: true,
      },
    ]);
  });

  it("points and certifies exactly the hostnames served by the vhost", async () => {
    const plan = await planSiteSsl({
      userId: "user-1",
      systemDomain: "site.example.test",
      aliases: ["example.com"],
      serverIp: "203.0.113.10",
      autoPoint: true,
    });

    expect(mocks.autoPointDns).toHaveBeenCalledWith(
      "user-1",
      "example.com",
      "203.0.113.10",
    );
    expect(mocks.autoPointDns).toHaveBeenCalledOnce();
    expect(mocks.resolveDnsOriginStatus).toHaveBeenCalledWith(
      "user-1",
      ["example.com"],
      "203.0.113.10",
    );
    expect(plan.san).toEqual(["example.com"]);
  });

  it("accepts a publicly resolved Cloudflare proxy with a verified origin", async () => {
    mocks.resolveDnsOriginStatus.mockResolvedValueOnce([
      {
        name: "example.com",
        ip: "104.16.1.1",
        ips: ["104.16.1.1"],
        publicIps: ["104.16.1.1"],
        publicResolved: true,
        managed: true,
        originVerified: true,
        proxied: true,
        pointed: true,
        chain: ["example.com"],
      },
    ]);

    const plan = await planSiteSsl({
      userId: "user-1",
      systemDomain: "site.example.test",
      aliases: ["example.com"],
      serverIp: "203.0.113.10",
    });

    expect(plan.san).toEqual(["example.com"]);
    expect(plan.warnings).toEqual([]);
  });

  it("returns an actionable warning when Cloudflare origin verification fails", async () => {
    mocks.resolveDnsOriginStatus.mockResolvedValueOnce([
      {
        name: "example.com",
        ip: "104.16.1.1",
        ips: ["104.16.1.1"],
        publicIps: ["104.16.1.1"],
        publicResolved: true,
        managed: true,
        originVerified: false,
        proxied: false,
        pointed: false,
        chain: ["example.com"],
        providerError: "Cloudflare records could not be verified.",
      },
    ]);

    const plan = await planSiteSsl({
      userId: "user-1",
      systemDomain: "site.example.test",
      aliases: ["example.com"],
      serverIp: "203.0.113.10",
    });

    expect(plan.san).toEqual([]);
    expect(plan.warnings[0]).toContain("Retry");
    expect(plan.warnings[0]).toContain("Cloudflare records could not be verified");
  });
});

describe("certificate activation", () => {
  const session = {} as CloudPanelSession;
  const domain = "site.example.test";
  const certificate = (id: string, domains = [domain, "example.com"]) => ({
    id,
    domains,
    type: "lets-encrypt",
    default: false,
    expiresAt: "2099-01-01T00:00:00Z",
  });

  beforeEach(() => vi.resetAllMocks());

  it("activates an existing covering certificate without issuing another", async () => {
    mocks.getSiteSection.mockResolvedValue({
      items: [certificate("existing")],
    });
    await expect(
      certificateAlreadyCovers(session, domain, [domain, "example.com"]),
    ).resolves.toBe(true);
    expect(mocks.manageSiteSection).toHaveBeenCalledExactlyOnceWith(
      session,
      domain,
      "certificates",
      { action: "set-default", id: "existing" },
    );
  });

  it("selects the covering certificate even when another expires later", async () => {
    mocks.manageSiteSection.mockResolvedValueOnce({
      items: [
        certificate("unrelated", [domain, "other.example.com"]),
        { ...certificate("covering"), expiresAt: "2098-01-01T00:00:00Z" },
      ],
    });
    await issueSiteSsl(session, domain, ["example.com"]);
    expect(mocks.manageSiteSection).toHaveBeenLastCalledWith(
      session,
      domain,
      "certificates",
      { action: "set-default", id: "covering" },
    );
  });

  it("reports activation failures instead of claiming HTTPS success", async () => {
    mocks.manageSiteSection
      .mockResolvedValueOnce({ items: [certificate("covering")] })
      .mockRejectedValueOnce(new Error("activation failed"));
    await expect(
      issueSiteSsl(session, domain, ["example.com"]),
    ).rejects.toThrow("activation failed");
  });

  it("rejects an issuance response without the requested coverage", async () => {
    mocks.manageSiteSection.mockResolvedValue({
      items: [certificate("wrong", [domain])],
    });
    await expect(
      issueSiteSsl(session, domain, ["example.com"]),
    ).rejects.toThrow("covering the requested addresses");
    expect(mocks.manageSiteSection).toHaveBeenCalledOnce();
  });
});
