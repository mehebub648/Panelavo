import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  requireUser: vi.fn(),
  createMcpPersonalToken: vi.fn(),
  revokeMcpConnection: vi.fn(),
  listMcpConnections: vi.fn(),
  getMcpPublicUrls: vi.fn(),
  audit: vi.fn(),
  assertWriteRequest: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/server/auth/require-user", () => ({
  requireUser: dependencies.requireUser,
}));
vi.mock("@/server/mcp/oauth", () => ({
  createMcpPersonalToken: dependencies.createMcpPersonalToken,
  revokeMcpConnection: dependencies.revokeMcpConnection,
  listMcpConnections: dependencies.listMcpConnections,
}));
vi.mock("@/server/mcp/public-url", () => ({
  getMcpPublicUrls: dependencies.getMcpPublicUrls,
}));
vi.mock("@/server/security/log", () => ({ audit: dependencies.audit }));
vi.mock("@/server/security/request", () => ({
  assertWriteRequest: dependencies.assertWriteRequest,
  rateLimit: dependencies.rateLimit,
}));

import { DELETE, POST } from "./route";

describe("MCP connection profile route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.requireUser.mockResolvedValue({
      user: { id: "42", username: "Admin", panelRole: "super-admin" },
    });
    dependencies.listMcpConnections.mockResolvedValue([]);
    dependencies.getMcpPublicUrls.mockReturnValue({
      resource: "https://panel.example.test/mcp",
    });
    dependencies.createMcpPersonalToken.mockResolvedValue({
      token: "pnl_mpat.secret",
      connection: {
        id: "3b0c4b0f-e4de-49ba-8aa7-b146675cd752",
        clientId: "pnl_personal_3b0c4b0f-e4de-49ba-8aa7-b146675cd752",
        clientName: "My laptop",
        kind: "personal-token",
        createdAt: 1,
        expiresAt: 2,
      },
    });
  });

  it("creates a user-bound MCP token and returns its secret once", async () => {
    const request = new NextRequest(
      "https://panel.example.test/api/profile/mcp-connections",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "My laptop", expiresInDays: 90 }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(201);
    expect(dependencies.createMcpPersonalToken).toHaveBeenCalledWith(
      "42",
      "Admin",
      { name: "My laptop", expiresInDays: 90 },
      { resource: "https://panel.example.test/mcp" },
    );
    expect(await response.json()).toMatchObject({
      success: true,
      data: { token: "pnl_mpat.secret" },
    });
    expect(dependencies.audit).toHaveBeenCalledWith(
      "profile.mcp_token.created",
      "success",
      expect.not.objectContaining({ token: expect.anything() }),
    );
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
