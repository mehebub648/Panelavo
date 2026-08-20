import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  requireUser: vi.fn(),
  reclaimServerStorage: vi.fn(),
  assertWriteRequest: vi.fn(),
}));

vi.mock("@/server/auth/require-user", () => ({
  requireUser: dependencies.requireUser,
}));
vi.mock("@/server/cloudpanel", () => ({
  getCloudPanelClient: () => ({
    reclaimServerStorage: dependencies.reclaimServerStorage,
  }),
}));
vi.mock("@/server/security/request", () => ({
  assertWriteRequest: dependencies.assertWriteRequest,
}));

import { POST } from "./route";

function request(confirmation = "RECLAIM BUILD CACHE") {
  return new NextRequest("https://panel.example.test/api/server/storage/reclaim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation }),
  });
}

describe("storage reclaim route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.requireUser.mockResolvedValue({
      user: { panelRole: "super-admin" },
      record: { cloudPanel: { usernameHint: "admin" } },
    });
    dependencies.reclaimServerStorage.mockResolvedValue({
      reclaimedBytes: 100,
      sites: [],
    });
  });

  it("requires an exact confirmation before running the privileged cleanup", async () => {
    const response = await POST(request("wrong"));

    expect(response.status).toBe(400);
    expect(dependencies.assertWriteRequest).toHaveBeenCalledOnce();
    expect(dependencies.reclaimServerStorage).not.toHaveBeenCalled();
  });

  it("runs only for a confirmed super administrator", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(dependencies.reclaimServerStorage).toHaveBeenCalledWith({
      usernameHint: "admin",
    });
  });

  it("rejects managers", async () => {
    dependencies.requireUser.mockResolvedValue({
      user: { panelRole: "manager" },
      record: { cloudPanel: { usernameHint: "manager" } },
    });

    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(dependencies.reclaimServerStorage).not.toHaveBeenCalled();
  });
});
