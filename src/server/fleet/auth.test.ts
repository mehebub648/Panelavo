import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireUserOrRedirect: vi.fn(),
}));
vi.mock("@/server/auth/require-user", () => mocks);

import {
  requireFleetSuperAdmin,
  requireFleetSuperAdminOrRedirect,
} from "./auth";

describe("Fleet role boundary", () => {
  beforeEach(() => {
    mocks.requireUser.mockReset();
    mocks.requireUserOrRedirect.mockReset();
  });

  it.each(["manager", "admin", "user"])(
    "returns API-forbidden and page-not-found behavior for %s",
    async (panelRole) => {
      const session = { user: { id: "1", username: "person", panelRole } };
      mocks.requireUser.mockResolvedValue(session);
      mocks.requireUserOrRedirect.mockResolvedValue(session);
      await expect(requireFleetSuperAdmin()).rejects.toMatchObject({
        status: 403,
      });
      await expect(requireFleetSuperAdminOrRedirect()).resolves.toBeNull();
    },
  );

  it("accepts a freshly revalidated Super Admin", async () => {
    const session = {
      user: { id: "1", username: "owner", panelRole: "super-admin" },
    };
    mocks.requireUser.mockResolvedValue(session);
    await expect(requireFleetSuperAdmin()).resolves.toBe(session);
  });
});
