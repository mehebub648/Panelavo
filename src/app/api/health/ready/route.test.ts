import { beforeEach, describe, expect, it, vi } from "vitest";

const getReadiness = vi.hoisted(() => vi.fn());
vi.mock("@/server/health/readiness", () => ({ getReadiness }));

import { GET } from "./route";

describe("readiness route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 only when every readiness check passes", async () => {
    getReadiness.mockResolvedValue({
      ready: true,
      checks: { configuration: "pass", cloudPanel: "pass" },
    });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      status: "ready",
      checks: { configuration: "pass", cloudPanel: "pass" },
    });
  });

  it("returns a minimal 503 without exposing dependency errors", async () => {
    getReadiness.mockResolvedValue({
      ready: false,
      checks: { configuration: "pass", cloudPanel: "fail" },
    });
    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "not_ready",
      checks: { configuration: "pass", cloudPanel: "fail" },
    });
  });
});
