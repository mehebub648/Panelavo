import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  requireUser: vi.fn(),
  revokeMcpConnection: vi.fn(),
  listMcpConnections: vi.fn(),
  audit: vi.fn(),
  assertWriteRequest: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/server/auth/require-user", () => ({
  requireUser: dependencies.requireUser,
}));
vi.mock("@/server/mcp/oauth", () => ({
  revokeMcpConnection: dependencies.revokeMcpConnection,
  listMcpConnections: dependencies.listMcpConnections,
}));
vi.mock("@/server/security/log", () => ({ audit: dependencies.audit }));
vi.mock("@/server/security/request", () => ({
  assertWriteRequest: dependencies.assertWriteRequest,
  rateLimit: dependencies.rateLimit,
}));

import { DELETE } from "./route";

describe("MCP connection profile route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.requireUser.mockResolvedValue({
      user: { id: "42", username: "Admin", panelRole: "super-admin" },
    });
    dependencies.listMcpConnections.mockResolvedValue([]);
  });

  it("revokes only a connection owned by the stable current identity", async () => {
    const id = "3b0c4b0f-e4de-49ba-8aa7-b146675cd752";
    const response = await DELETE(
      new NextRequest(
        "https://panel.example.test/api/profile/mcp-connections",
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(dependencies.requireUser).toHaveBeenCalledWith({
      allowDuringUpdate: true,
    });
    expect(dependencies.revokeMcpConnection).toHaveBeenCalledWith(
      "42",
      "Admin",
      id,
    );
    expect(dependencies.listMcpConnections).toHaveBeenCalledWith("42", "Admin");
  });

  it("rejects an invalid connection id before revoking anything", async () => {
    const response = await DELETE(
      new NextRequest(
        "https://panel.example.test/api/profile/mcp-connections",
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "not-a-connection" }),
        },
      ),
    );

    expect(response.status).toBe(400);
    expect(dependencies.revokeMcpConnection).not.toHaveBeenCalled();
  });
});
