import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/network/server-ip", () => ({
  getServerPublicIp: vi.fn(),
}));
vi.mock("@/server/settings/store", () => ({
  getBaseDomain: vi.fn(),
}));
vi.mock("@/server/network/dns", () => ({
  resolveDnsStatus: vi.fn(),
  systemWildcardDomain: (ip: string, base: string) =>
    `*.${ip}.${base}`.toLowerCase(),
}));

import { getServerPublicIp } from "@/server/network/server-ip";
import { getBaseDomain } from "@/server/settings/store";
import { resolveDnsStatus } from "@/server/network/dns";
import { getSystemStatus, invalidateSystemStatus } from "./system-status";
import { parseIppointerResponse } from "./ippointer";

const setEnv = (baseDomain: string, ip: string) => {
  vi.mocked(getBaseDomain).mockResolvedValue(baseDomain);
  vi.mocked(getServerPublicIp).mockResolvedValue(ip);
};
const dnsReturns = (pointed: boolean, ips: string[]) =>
  vi
    .mocked(resolveDnsStatus)
    .mockResolvedValue([
      { name: "probe", ip: ips[0] ?? null, ips, pointed },
    ]);

describe("getSystemStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateSystemStatus();
  });

  it("is ready when the wildcard resolves to this server", async () => {
    setEnv("mehebub.com", "1.2.3.4");
    dnsReturns(true, ["1.2.3.4"]);
    const status = await getSystemStatus({ refresh: true });
    expect(status.ready).toBe(true);
    expect(status.pointed).toBe(true);
    expect(status.canAutoRegister).toBe(true);
    expect(status.wildcardDomain).toBe("*.1.2.3.4.mehebub.com");
    expect(status.reason).toBe("");
  });

  it("is not ready when the wildcard points elsewhere", async () => {
    setEnv("mehebub.com", "1.2.3.4");
    dnsReturns(false, ["9.9.9.9"]);
    const status = await getSystemStatus({ refresh: true });
    expect(status.ready).toBe(false);
    expect(status.reason).toContain("*.1.2.3.4.mehebub.com");
  });

  it("is not ready and cannot auto-register without a base domain", async () => {
    setEnv("", "1.2.3.4");
    const status = await getSystemStatus({ refresh: true });
    expect(status.ready).toBe(false);
    expect(status.canAutoRegister).toBe(false);
    expect(resolveDnsStatus).not.toHaveBeenCalled();
    expect(status.reason).toContain("base domain");
  });

  it("only auto-registers the mehebub.com base domain", async () => {
    setEnv("example.com", "1.2.3.4");
    dnsReturns(true, ["1.2.3.4"]);
    const status = await getSystemStatus({ refresh: true });
    expect(status.ready).toBe(true);
    expect(status.canAutoRegister).toBe(false);
  });

  it("uses a fresh random probe label each check (defeats negative cache)", async () => {
    setEnv("mehebub.com", "1.2.3.4");
    dnsReturns(true, ["1.2.3.4"]);
    const first = await getSystemStatus({ refresh: true });
    const second = await getSystemStatus({ refresh: true });
    expect(first.probeName).not.toBe(second.probeName);
    for (const name of [first.probeName, second.probeName]) {
      expect(name).toMatch(/^probe-[0-9a-f]+\.1\.2\.3\.4\.mehebub\.com$/);
    }
  });

  it("caches the result until refreshed", async () => {
    setEnv("mehebub.com", "1.2.3.4");
    dnsReturns(true, ["1.2.3.4"]);
    await getSystemStatus({ refresh: true });
    await getSystemStatus();
    await getSystemStatus();
    // one refresh call + cached reads => resolver hit exactly once
    expect(resolveDnsStatus).toHaveBeenCalledTimes(1);
  });
});

describe("parseIppointerResponse", () => {
  it("parses a successful registration", () => {
    const result = parseIppointerResponse(200, {
      success: true,
      action: "created",
      record: "*.1.2.3.4.mehebub.com",
      points_to: "1.2.3.4",
    });
    expect(result).toEqual({
      ok: true,
      action: "created",
      record: "*.1.2.3.4.mehebub.com",
      pointsTo: "1.2.3.4",
    });
  });

  it("surfaces the ippointer error message on rejection", () => {
    const result = parseIppointerResponse(403, {
      success: false,
      error: "Request IP does not match submitted IP",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Request IP does not match submitted IP");
  });

  it("falls back to an HTTP status message", () => {
    const result = parseIppointerResponse(500, {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("ippointer returned HTTP 500");
  });
});
