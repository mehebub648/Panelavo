import { beforeEach, describe, expect, it, vi } from "vitest";

const cloudflare = vi.hoisted(() => ({
  checkARecord: vi.fn(),
  getZones: vi.fn(),
  setARecord: vi.fn(),
}));

vi.mock("@/server/cloudflare/store", () => cloudflare);

import { pointDns } from "./point-dns";

describe("pointDns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("creates missing records and returns companion conflicts as data", async () => {
    cloudflare.checkARecord.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "www",
      name: "www.example.com",
      content: "192.0.2.20",
    });
    cloudflare.setARecord
      .mockResolvedValueOnce({
        id: "apex",
        name: "example.com",
        content: "192.0.2.10",
      })
      .mockRejectedValueOnce(new Error("conflict"));

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
      "failed",
    ]);
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
