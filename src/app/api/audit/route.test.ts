import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  requireUser: vi.fn(),
  readAuditEvents: vi.fn(),
}));

vi.mock("@/server/auth/require-user", () => ({
  requireUser: dependencies.requireUser,
}));
vi.mock("@/server/security/log", () => ({
  readAuditEvents: dependencies.readAuditEvents,
}));

import { GET } from "./route";

describe("audit route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes bounded filters to the ledger for super administrators", async () => {
    dependencies.requireUser.mockResolvedValue({
      user: { panelRole: "super-admin" },
    });
    dependencies.readAuditEvents.mockResolvedValue({
      events: [],
      pagination: { page: 2, pageSize: 25, total: 0, totalPages: 1 },
      integrity: { valid: true, checkedEvents: 0, issues: [] },
    });

    const response = await GET(
      new NextRequest(
        "https://panel.example.test/api/audit?page=2&user=admin&site=example.com",
      ),
    );

    expect(response.status).toBe(200);
    expect(dependencies.readAuditEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 2,
        pageSize: 25,
        actor: "admin",
        target: "example.com",
      }),
    );
  });

  it("rejects non-super-admin users", async () => {
    dependencies.requireUser.mockResolvedValue({
      user: { panelRole: "manager" },
    });

    const response = await GET(
      new NextRequest("https://panel.example.test/api/audit"),
    );
    expect(response.status).toBe(403);
    expect(dependencies.readAuditEvents).not.toHaveBeenCalled();
  });
});
