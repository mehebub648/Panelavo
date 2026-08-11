import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/network/server-ip", () => ({
  getServerPublicIp: vi.fn(),
}));
vi.mock("@/server/settings/store", () => ({
  getPanelSettings: vi.fn(),
}));
vi.mock("@/server/network/dns", () => ({
  resolveDnsStatus: vi.fn(),
  systemWildcardDomain: (ip: string, base: string) =>
    `*.${ip}.${base}`.toLowerCase(),
}));

import { getServerPublicIp } from "@/server/network/server-ip";
import { getPanelSettings } from "@/server/settings/store";
import { resolveDnsStatus } from "@/server/network/dns";
import { getSystemStatus, invalidateSystemStatus } from "./system-status";

const setEnv = (baseDomain: string, ip: string) => {
  vi.mocked(getPanelSettings).mockResolvedValue({
    baseDomain,
    addressMode: baseDomain === "sslip.io" ? "sslip" : "custom",
    updateRepository: "",
  });
  vi.mocked(getServerPublicIp).mockResolvedValue(ip);
};
const dnsReturns = (pointed: boolean, ips: string[]) =>
  vi
    .mocked(resolveDnsStatus)
    .mockResolvedValue([{ name: "probe", ip: ips[0] ?? null, ips, pointed }]);

describe("getSystemStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateSystemStatus();
  });

  it("is ready when the wildcard resolves to this server", async () => {
    setEnv("managed.test", "1.2.3.4");
    dnsReturns(true, ["1.2.3.4"]);
    const status = await getSystemStatus({ refresh: true });
    expect(status.ready).toBe(true);
    expect(status.pointed).toBe(true);
    expect(status.wildcardDomain).toBe("*.1.2.3.4.managed.test");
    expect(status.reason).toBe("");
  });

  it("is not ready when the wildcard points elsewhere", async () => {
    setEnv("managed.test", "1.2.3.4");
    dnsReturns(false, ["9.9.9.9"]);
    const status = await getSystemStatus({ refresh: true });
    expect(status.ready).toBe(false);
    expect(status.reason).toContain("*.1.2.3.4.managed.test");
  });

  it("is not ready without a base domain", async () => {
    setEnv("", "1.2.3.4");
    const status = await getSystemStatus({ refresh: true });
    expect(status.ready).toBe(false);
    expect(resolveDnsStatus).not.toHaveBeenCalled();
    expect(status.reason).toContain("base domain");
  });

  it("verifies the generated sslip hostname directly", async () => {
    setEnv("sslip.io", "1.2.3.4");
    dnsReturns(true, ["1.2.3.4"]);
    const status = await getSystemStatus({ refresh: true });
    expect(status.addressMode).toBe("sslip");
    expect(status.probeName).toBe("panel.1.2.3.4.sslip.io");
  });

  it("uses a fresh random probe label each check (defeats negative cache)", async () => {
    setEnv("managed.test", "1.2.3.4");
    dnsReturns(true, ["1.2.3.4"]);
    const first = await getSystemStatus({ refresh: true });
    const second = await getSystemStatus({ refresh: true });
    expect(first.probeName).not.toBe(second.probeName);
    for (const name of [first.probeName, second.probeName]) {
      expect(name).toMatch(/^probe-[0-9a-f]+\.1\.2\.3\.4\.managed\.test$/);
    }
  });

  it("caches the result until refreshed", async () => {
    setEnv("managed.test", "1.2.3.4");
    dnsReturns(true, ["1.2.3.4"]);
    await getSystemStatus({ refresh: true });
    await getSystemStatus();
    await getSystemStatus();
    // one refresh call + cached reads => resolver hit exactly once
    expect(resolveDnsStatus).toHaveBeenCalledTimes(1);
  });
});
