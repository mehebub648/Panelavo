import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInviteToken, verifyInviteToken } from "./invites";

const payload = {
  username: "jane.doe",
  email: "jane@example.com",
  firstName: "Jane",
  lastName: "Doe",
  role: "admin" as const,
  sites: ["example.com"],
  timezone: "Europe/Berlin",
  invitedBy: "admin",
};

describe("invite tokens", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "test-secret-test-secret-test-secret!";
  });

  it("round-trips a signed payload", () => {
    const token = createInviteToken(payload);
    const verified = verifyInviteToken(token);
    expect(verified).toMatchObject(payload);
    expect(verified!.exp - verified!.iat).toBe(24 * 60 * 60);
  });

  it("rejects tampered tokens", () => {
    const token = createInviteToken(payload);
    const [head, claims, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...payload, role: "super-admin", iat: 0, exp: 9999999999 }),
    ).toString("base64url");
    expect(verifyInviteToken(`${head}.${forged}.${signature}`)).toBeNull();
    expect(verifyInviteToken(`${head}.${claims}.AAAA`)).toBeNull();
    expect(verifyInviteToken("garbage")).toBeNull();
  });

  it("rejects expired tokens", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    const token = createInviteToken(payload);
    vi.setSystemTime(new Date("2026-07-02T00:00:01Z"));
    expect(verifyInviteToken(token)).toBeNull();
    vi.useRealTimers();
  });

  it("rejects tokens signed with another secret", () => {
    const token = createInviteToken(payload);
    process.env.SESSION_SECRET = "different-secret-different-secret-!!";
    expect(verifyInviteToken(token)).toBeNull();
  });
});
