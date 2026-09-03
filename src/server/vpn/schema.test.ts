import { describe, expect, it } from "vitest";
import { vpnManageSchema } from "./schema";

describe("vpnManageSchema", () => {
  it("accepts a bounded private /24 installation", () => {
    expect(
      vpnManageSchema.parse({
        action: "install",
        endpoint: "vpn.example.test",
        listenPort: 51820,
        ipv4Cidr: "10.66.66.0/24",
        dns: ["1.1.1.1", "2606:4700:4700::1111"],
        confirmation: "INSTALL VPN",
      }),
    ).toMatchObject({ action: "install", listenPort: 51820 });
  });

  it("rejects public, non-/24, and non-network tunnel ranges", () => {
    for (const ipv4Cidr of ["8.8.8.0/24", "10.66.66.0/16", "10.66.66.1/24"]) {
      expect(() =>
        vpnManageSchema.parse({
          action: "install",
          endpoint: "203.0.113.10",
          listenPort: 51820,
          ipv4Cidr,
          dns: ["1.1.1.1"],
          confirmation: "INSTALL VPN",
        }),
      ).toThrow();
    }
  });

  it("keeps device actions strict and identifier-bound", () => {
    expect(
      vpnManageSchema.parse({ action: "create-device", name: "Work phone" }),
    ).toEqual({ action: "create-device", name: "Work phone" });
    expect(() =>
      vpnManageSchema.parse({
        action: "revoke-device",
        deviceId: "../../etc/passwd",
        confirmation: "REVOKE DEVICE",
      }),
    ).toThrow();
    expect(() =>
      vpnManageSchema.parse({
        action: "stop",
        confirmation: "STOP VPN",
        command: "systemctl stop ssh",
      }),
    ).toThrow();
    expect(() =>
      vpnManageSchema.parse({ action: "uninstall", confirmation: "yes" }),
    ).toThrow();
  });

  it("rejects private DNS resolvers that the gateway firewall cannot reach", () => {
    expect(() =>
      vpnManageSchema.parse({
        action: "install",
        endpoint: "vpn.example.test",
        listenPort: 51820,
        ipv4Cidr: "10.66.66.0/24",
        dns: ["192.168.1.53"],
        confirmation: "INSTALL VPN",
      }),
    ).toThrow();
    expect(() =>
      vpnManageSchema.parse({
        action: "install",
        endpoint: "vpn.example.test",
        listenPort: 51820,
        ipv4Cidr: "10.66.66.0/24",
        dns: ["2606:4700:4700::1111"],
        confirmation: "INSTALL VPN",
      }),
    ).toThrow();
  });
});
