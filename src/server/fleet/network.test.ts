import { describe, expect, it } from "vitest";
import { isPublicFleetAddress, parseFleetOrigin } from "./network";

describe("Fleet outbound address policy", () => {
  it("accepts only canonical public HTTPS origins on port 443", () => {
    expect(parseFleetOrigin("https://panel.example.com/")).toBe(
      "https://panel.example.com",
    );
    for (const value of [
      "http://panel.example.com",
      "https://panel.example.com:8443",
      "https://user:pass@panel.example.com",
      "https://panel.example.com/path",
      "https://127.0.0.1",
      "https://panel.example.com/?next=x",
    ])
      expect(() => parseFleetOrigin(value)).toThrow(/public HTTPS|port 443/);
  });

  it("blocks IPv4 and IPv6 loopback, private, metadata, link-local, multicast, and documentation ranges", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "100.64.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "224.0.0.1",
      "203.0.113.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "ff02::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
    ])
      expect(isPublicFleetAddress(address), address).toBe(false);
    expect(isPublicFleetAddress("1.1.1.1")).toBe(true);
    expect(isPublicFleetAddress("2606:4700:4700::1111")).toBe(true);
  });
});
