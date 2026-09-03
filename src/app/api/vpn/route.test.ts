import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getVpnState: vi.fn(),
  manageVpn: vi.fn(),
  audit: vi.fn(),
  toDataURL: vi.fn(),
  assertWriteRequest: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/server/auth/require-user", () => ({
  requireUser: dependencies.requireUser,
}));
vi.mock("@/server/cloudpanel", () => ({
  getCloudPanelClient: () => ({
    getVpnState: dependencies.getVpnState,
    manageVpn: dependencies.manageVpn,
  }),
}));
vi.mock("@/server/security/log", () => ({ audit: dependencies.audit }));
vi.mock("@/server/security/request", () => ({
  assertWriteRequest: dependencies.assertWriteRequest,
  rateLimit: dependencies.rateLimit,
}));
vi.mock("qrcode", () => ({
  default: { toDataURL: dependencies.toDataURL },
}));

import { GET, POST } from "./route";

const session = {
  user: { id: "1", username: "root", panelRole: "super-admin" },
  record: { cloudPanel: { cliAuthenticated: true, usernameHint: "root" } },
};

function request(body: unknown) {
  return new NextRequest("https://panel.example.test/api/vpn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("VPN API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.requireUser.mockResolvedValue(session);
    dependencies.audit.mockResolvedValue(undefined);
  });

  it("returns no-store VPN state to a Super Admin", async () => {
    dependencies.getVpnState.mockResolvedValue({ installed: false });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(dependencies.getVpnState).toHaveBeenCalledWith(
      session.record.cloudPanel,
    );
  });

  it("rejects managers before reaching the broker", async () => {
    dependencies.requireUser.mockResolvedValue({
      ...session,
      user: { ...session.user, panelRole: "manager" },
    });
    const response = await POST(request({ action: "start" }));
    expect(response.status).toBe(403);
    expect(dependencies.manageVpn).not.toHaveBeenCalled();
  });

  it("validates the strict action shape", async () => {
    const response = await POST(
      request({
        action: "stop",
        confirmation: "STOP VPN",
        command: "systemctl stop ssh",
      }),
    );
    expect(response.status).toBe(400);
    expect(dependencies.manageVpn).not.toHaveBeenCalled();
  });

  it("renders a one-time QR response without auditing the private config", async () => {
    dependencies.manageVpn.mockResolvedValue({
      state: { installed: true },
      provisioning: {
        device: { id: "0123456789abcdef", name: "Phone" },
        configuration: "[Interface]\nPrivateKey = secret",
      },
    });
    dependencies.toDataURL.mockResolvedValue("data:image/png;base64,qr");

    const response = await POST(
      request({ action: "create-device", name: "Phone" }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.data.provisioning.qrCode).toBe("data:image/png;base64,qr");
    expect(dependencies.audit).toHaveBeenCalledWith(
      "vpn.create-device",
      "success",
      expect.objectContaining({ deviceId: "0123456789abcdef" }),
    );
    expect(JSON.stringify(dependencies.audit.mock.calls)).not.toContain(
      "PrivateKey",
    );
  });

  it("still returns the one-time configuration when QR rendering fails", async () => {
    dependencies.manageVpn.mockResolvedValue({
      state: { installed: true },
      provisioning: {
        device: { id: "0123456789abcdef", name: "Phone" },
        configuration: "[Interface]\nPrivateKey = one-time-secret",
      },
    });
    dependencies.toDataURL.mockRejectedValue(new Error("QR unavailable"));

    const response = await POST(
      request({ action: "create-device", name: "Phone" }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.provisioning.configuration).toContain("one-time-secret");
    expect(body.data.provisioning.qrCode).toBeUndefined();
  });
});
