import { beforeEach, describe, expect, it, vi } from "vitest";

const cloudflare = vi.hoisted(() => ({
  getAddressRecords: vi.fn(),
  getZones: vi.fn(),
  setARecord: vi.fn(),
}));
const dns = vi.hoisted(() => ({ resolveDnsStatus: vi.fn() }));

vi.mock("@/server/cloudflare/store", () => cloudflare);
vi.mock("@/server/network/dns", () => dns);

import { pointDns } from "./point-dns";

describe("pointDns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dns.resolveDnsStatus.mockResolvedValue([
      { name: "www.example.com", ip: null, ips: [], pointed: false },
    ]);
    cloudflare.getZones.mockResolvedValue({
      zones: [
        {
          id: "zone-1",
          name: "example.com",
          credentialId: "credential-1",
        },
      ],
    });
  });

  it("creates only the requested served hostname", async () => {
    cloudflare.getAddressRecords.mockResolvedValue([]);
    cloudflare.setARecord.mockResolvedValueOnce({
      id: "apex",
      name: "example.com",
      content: "192.0.2.10",
    });

    const result = await pointDns({
      userId: "user-1",
      domain: "example.com",
      serverIp: "192.0.2.10",
    });

    expect(result.managed).toBe(true);
    expect(result.primaryOk).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
      "created",
    ]);
    expect(cloudflare.setARecord).toHaveBeenCalledOnce();
  });

  it("preserves a CNAME chain that reaches this server", async () => {
    const cname = {
      id: "www",
      type: "CNAME",
      name: "www.example.com",
      content: "example.com",
      proxied: true,
    };
    cloudflare.getAddressRecords
      .mockResolvedValueOnce([cname])
      .mockResolvedValueOnce([cname])
      .mockResolvedValueOnce([
        {
          id: "apex",
          type: "A",
          name: "example.com",
          content: "192.0.2.10",
          proxied: true,
        },
      ]);

    const result = await pointDns({
      userId: "user-1",
      domain: "www.example.com",
      serverIp: "192.0.2.10",
    });

    expect(result).toMatchObject({
      managed: true,
      primaryOk: true,
      changed: false,
      outcomes: [{ status: "unchanged", record: cname }],
    });
    expect(cloudflare.setARecord).not.toHaveBeenCalled();
  });

  it("does not overwrite a conflicting CNAME even when A replacement is allowed", async () => {
    const cname = {
      id: "www",
      type: "CNAME",
      name: "www.example.com",
      content: "elsewhere.example.net",
      proxied: false,
    };
    cloudflare.getAddressRecords
      .mockResolvedValueOnce([cname])
      .mockResolvedValueOnce([cname])
      .mockResolvedValueOnce([]);

    const result = await pointDns({
      userId: "user-1",
      domain: "www.example.com",
      serverIp: "192.0.2.10",
      replace: true,
    });

    expect(result.primaryOk).toBe(false);
    expect(result.outcomes[0]?.error).toMatchObject({
      message: expect.stringContaining(
        "Change or remove that CNAME in Cloudflare, then retry.",
      ),
    });
    expect(cloudflare.setARecord).not.toHaveBeenCalled();
  });

  it("preserves an external CNAME when public DNS reaches this server directly", async () => {
    const cname = {
      id: "www",
      type: "CNAME",
      name: "www.example.com",
      content: "external.example.net",
      proxied: false,
    };
    cloudflare.getAddressRecords
      .mockResolvedValueOnce([cname])
      .mockResolvedValueOnce([cname])
      .mockResolvedValueOnce([]);
    dns.resolveDnsStatus.mockResolvedValueOnce([
      {
        name: "www.example.com",
        ip: "192.0.2.10",
        ips: ["192.0.2.10"],
        pointed: true,
      },
    ]);

    const result = await pointDns({
      userId: "user-1",
      domain: "www.example.com",
      serverIp: "192.0.2.10",
    });

    expect(result).toMatchObject({
      primaryOk: true,
      changed: false,
      outcomes: [{ status: "unchanged", record: cname }],
    });
    expect(cloudflare.setARecord).not.toHaveBeenCalled();
  });

  it("reports an unmanaged domain without throwing", async () => {
    cloudflare.getZones.mockResolvedValue({ zones: [] });

    const result = await pointDns({
      userId: "user-1",
      domain: "unmanaged.test",
      serverIp: "192.0.2.10",
    });

    expect(result).toMatchObject({
      managed: false,
      primaryOk: false,
      changed: false,
    });
    expect(cloudflare.setARecord).not.toHaveBeenCalled();
  });
});
