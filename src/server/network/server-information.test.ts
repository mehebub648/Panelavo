import { networkInterfaces } from "node:os";
import { beforeEach, expect, it, vi } from "vitest";
import { getPanelSelfDomain } from "@/server/sites/panel-self";
import { completeServerInformation } from "./server-information";
import type { ServerInfo } from "@/types/cloudpanel";

vi.mock("node:os", () => ({ networkInterfaces: vi.fn() }));
vi.mock("@/server/sites/panel-self", () => ({
  getPanelSelfDomain: vi.fn(),
}));

const info = { ip: "203.0.113.4" } as ServerInfo;

beforeEach(() => {
  vi.mocked(getPanelSelfDomain).mockReturnValue("panel.example.com");
  vi.mocked(networkInterfaces).mockReturnValue({
    eth0: [
      {
        address: "2001:db8::10",
        netmask: "ffff:ffff:ffff:ffff::",
        family: "IPv6",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "2001:db8::10/64",
        scopeid: 0,
      },
      {
        address: "fe80::10",
        netmask: "ffff:ffff:ffff:ffff::",
        family: "IPv6",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "fe80::10/64",
        scopeid: 2,
      },
    ],
  });
});

it("adds the panel origin and public IP families without link-local IPv6", () => {
  expect(completeServerInformation(info)).toMatchObject({
    panelAddress: "https://panel.example.com",
    ipv4Addresses: ["203.0.113.4"],
    ipv6Addresses: ["2001:db8::10"],
  });
});

it("reports unavailable address families honestly", () => {
  vi.mocked(getPanelSelfDomain).mockReturnValue(null);
  vi.mocked(networkInterfaces).mockReturnValue({});
  expect(completeServerInformation({ ...info, ip: "" })).toMatchObject({
    panelAddress: "",
    ipv4Addresses: [],
    ipv6Addresses: [],
  });
});
