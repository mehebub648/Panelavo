import { afterEach, describe, expect, it, vi } from "vitest";
const dns = vi.hoisted(() => ({ a: vi.fn(), aaaa: vi.fn() }));
vi.mock("node:dns/promises", () => ({ resolve4: dns.a, resolve6: dns.aaaa }));
import { panelFetch } from "./network";
describe("plugin outgoing endpoint protection", () => {
  afterEach(() => vi.resetAllMocks());
  it.each([
    "http://source.example.com/mcp",
    "https://127.0.0.1/mcp",
    "https://source.example.com:8443/mcp",
    "https://source.example.com/private",
    "https://source.example.com/mcp?next=private",
    "https://user:secret@source.example.com/mcp",
  ])("rejects an unsafe destination %s", async (url) => {
    await expect(panelFetch(url)).rejects.toThrow();
  });
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.2"])(
    "rejects private DNS answers %s",
    async (address) => {
      dns.a.mockResolvedValue(["93.184.216.34", address]);
      dns.aaaa.mockResolvedValue([]);
      await expect(
        panelFetch("https://source.example.com/mcp"),
      ).rejects.toThrow("public");
    },
  );
  it.each(["::ffff:7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::"])(
    "rejects IPv6 translation and tunnel addresses %s",
    async (address) => {
      dns.a.mockResolvedValue([]);
      dns.aaaa.mockResolvedValue([address]);
      await expect(
        panelFetch("https://source.example.com/mcp"),
      ).rejects.toThrow("public");
    },
  );
});
