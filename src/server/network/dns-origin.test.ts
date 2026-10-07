import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAddressRecords: vi.fn(),
  getZones: vi.fn(),
  resolveDnsStatus: vi.fn(),
}));

vi.mock("@/server/cloudflare/store", () => ({
  getAddressRecords: mocks.getAddressRecords,
  getZones: mocks.getZones,
}));
vi.mock("@/server/network/dns", () => ({
  resolveDnsStatus: mocks.resolveDnsStatus,
}));

import { resolveDnsOriginStatus } from "./dns-origin";

const zone = {
  id: "zone-1",
  name: "example.com",
  credentialId: "credential-1",
};

describe("DNS origin verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getZones.mockResolvedValue({ zones: [zone] });
  });

  it("accepts public Cloudflare edge IPs when the provider A record proves the origin", async () => {
    mocks.resolveDnsStatus.mockResolvedValue([
      {
        name: "example.com",
        ip: "104.16.1.1",
        ips: ["104.16.1.1", "104.16.2.1"],
        pointed: false,
      },
    ]);
    mocks.getAddressRecords.mockResolvedValue([
      {
        id: "apex",
        type: "A",
        name: "example.com",
        content: "192.0.2.10",
        proxied: true,
      },
    ]);

    const [status] = await resolveDnsOriginStatus(
      "user-1",
      ["example.com"],
      "192.0.2.10",
    );

    expect(status).toMatchObject({
      publicResolved: true,
      managed: true,
      originVerified: true,
      proxied: true,
      pointed: true,
    });
  });

  it("follows a managed CNAME chain to the origin", async () => {
    mocks.resolveDnsStatus.mockResolvedValue([
      {
        name: "www.example.com",
        ip: "104.16.1.1",
        ips: ["104.16.1.1"],
        pointed: false,
      },
    ]);
    mocks.getAddressRecords.mockImplementation(
      async (_userId: string, _credentialId: string, _zoneId: string, name: string) =>
        name === "www.example.com"
          ? [
              {
                id: "www",
                type: "CNAME",
                name,
                content: "example.com",
                proxied: true,
              },
            ]
          : [
              {
                id: "apex",
                type: "A",
                name,
                content: "192.0.2.10",
                proxied: true,
              },
            ],
    );

    const [status] = await resolveDnsOriginStatus(
      "user-1",
      ["www.example.com"],
      "192.0.2.10",
    );

    expect(status).toMatchObject({
      originVerified: true,
      pointed: true,
      chain: ["www.example.com", "example.com"],
    });
  });

  it("requires public DNS to resolve even when the provider record is correct", async () => {
    mocks.resolveDnsStatus.mockResolvedValue([
      { name: "example.com", ip: null, ips: [], pointed: false },
    ]);
    mocks.getAddressRecords.mockResolvedValue([
      {
        id: "apex",
        type: "A",
        name: "example.com",
        content: "192.0.2.10",
        proxied: false,
      },
    ]);

    const [status] = await resolveDnsOriginStatus(
      "user-1",
      ["example.com"],
      "192.0.2.10",
    );

    expect(status).toMatchObject({
      publicResolved: false,
      originVerified: false,
      pointed: false,
    });
  });

  it("rejects a plain managed A record while public DNS still resolves elsewhere", async () => {
    mocks.resolveDnsStatus.mockResolvedValue([
      {
        name: "example.com",
        ip: "198.51.100.20",
        ips: ["198.51.100.20"],
        pointed: false,
      },
    ]);
    mocks.getAddressRecords.mockResolvedValue([
      {
        id: "apex",
        type: "A",
        name: "example.com",
        content: "192.0.2.10",
        proxied: false,
      },
    ]);

    const [status] = await resolveDnsOriginStatus(
      "user-1",
      ["example.com"],
      "192.0.2.10",
    );

    expect(status).toMatchObject({
      publicResolved: true,
      originVerified: false,
      proxied: false,
      pointed: false,
    });
  });

  it("returns an unverified status when provider lookup fails", async () => {
    mocks.resolveDnsStatus.mockResolvedValue([
      {
        name: "example.com",
        ip: "104.16.1.1",
        ips: ["104.16.1.1"],
        pointed: false,
      },
    ]);
    mocks.getAddressRecords.mockRejectedValue(new Error("Cloudflare unavailable"));

    const [status] = await resolveDnsOriginStatus(
      "user-1",
      ["example.com"],
      "192.0.2.10",
    );

    expect(status).toMatchObject({
      publicResolved: true,
      managed: true,
      originVerified: false,
      pointed: false,
      providerError: "Cloudflare records could not be verified.",
    });
  });

  it("accepts direct wildcard DNS when the connected zone has no exact record", async () => {
    mocks.resolveDnsStatus.mockResolvedValue([
      {
        name: "site.example.com",
        ip: "192.0.2.10",
        ips: ["192.0.2.10"],
        pointed: true,
      },
    ]);
    mocks.getAddressRecords.mockResolvedValue([]);

    const [status] = await resolveDnsOriginStatus(
      "user-1",
      ["site.example.com"],
      "192.0.2.10",
    );

    expect(status).toMatchObject({
      managed: true,
      publicResolved: true,
      originVerified: true,
      pointed: true,
      chain: ["site.example.com"],
    });
  });

  it("keeps direct public proof when provider record lookup fails", async () => {
    mocks.resolveDnsStatus.mockResolvedValue([
      {
        name: "site.example.com",
        ip: "192.0.2.10",
        ips: ["192.0.2.10"],
        pointed: true,
      },
    ]);
    mocks.getAddressRecords.mockRejectedValue(new Error("Cloudflare unavailable"));

    const [status] = await resolveDnsOriginStatus(
      "user-1",
      ["site.example.com"],
      "192.0.2.10",
    );

    expect(status).toMatchObject({
      managed: true,
      publicResolved: true,
      originVerified: true,
      pointed: true,
      providerError: "Cloudflare records could not be verified.",
    });
  });

  it("keeps direct public DNS verification for names outside connected zones", async () => {
    mocks.getZones.mockResolvedValue({ zones: [] });
    mocks.resolveDnsStatus.mockResolvedValue([
      {
        name: "external.test",
        ip: "192.0.2.10",
        ips: ["192.0.2.10"],
        pointed: true,
      },
    ]);

    const [status] = await resolveDnsOriginStatus(
      "user-1",
      ["external.test"],
      "192.0.2.10",
    );

    expect(status).toMatchObject({
      managed: false,
      publicResolved: true,
      originVerified: true,
      pointed: true,
    });
    expect(mocks.getAddressRecords).not.toHaveBeenCalled();
  });
});
