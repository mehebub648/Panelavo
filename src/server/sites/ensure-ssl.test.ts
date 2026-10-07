import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  autoPointDns: vi.fn(),
  resolveDnsStatus: vi.fn(),
}));

vi.mock("@/server/network/auto-dns", () => ({
  autoPointDns: mocks.autoPointDns,
}));
vi.mock("@/server/network/dns", () => ({
  resolveDnsStatus: mocks.resolveDnsStatus,
}));

import { planSiteSsl } from "./ensure-ssl";

describe("site SSL planning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.autoPointDns.mockResolvedValue({ changed: false });
    mocks.resolveDnsStatus.mockResolvedValue([
      {
        name: "example.com",
        ip: "203.0.113.10",
        ips: ["203.0.113.10"],
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
    expect(mocks.resolveDnsStatus).toHaveBeenCalledWith(
      ["example.com"],
      "203.0.113.10",
    );
    expect(plan.san).toEqual(["example.com"]);
  });
});
