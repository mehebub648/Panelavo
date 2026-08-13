import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelActor } from "./site-access";

const { requireUser, listSites, getSiteMeta } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  listSites: vi.fn(),
  getSiteMeta: vi.fn(),
}));

vi.mock("@/server/auth/require-user", () => ({
  requireUser,
  requireUserOrRedirect: requireUser,
}));
vi.mock("@/server/cloudpanel", () => ({
  getCloudPanelClient: () => ({ listSites }),
}));
vi.mock("@/server/sites/site-meta", () => ({ getSiteMeta }));

import {
  accessibleDomainTargetForActor,
  requireAccessibleDomainTarget,
  requireAccessibleSite,
  requireWritableSite,
} from "./site-access";

const record = { cloudPanel: { cookies: {}, usernameHint: "user-a" } };

function session(overrides: Record<string, unknown> = {}) {
  return {
    record,
    user: {
      id: "1",
      username: "user-a",
      canCreateSites: false,
      panelRole: "user",
      ...overrides,
    },
  };
}

describe("site access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue(session());
    listSites.mockResolvedValue([
      { id: "site-x-id", domain: "site-x.example.com" },
    ]);
    getSiteMeta.mockResolvedValue(null);
  });

  it("returns 404 for an unassigned or recreated site", async () => {
    await expect(
      requireAccessibleSite("site-y.example.com"),
    ).rejects.toMatchObject({
      code: "SITE_NOT_FOUND",
      status: 404,
    });
  });

  it("checks site visibility before write permission", async () => {
    await expect(
      requireWritableSite("site-y.example.com"),
    ).rejects.toMatchObject({
      code: "SITE_NOT_FOUND",
      status: 404,
    });
    await expect(
      requireWritableSite("site-x.example.com"),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  it("allows an assigned panel admin to write", async () => {
    requireUser.mockResolvedValue(
      session({ canCreateSites: true, panelRole: "admin" }),
    );
    await expect(
      requireWritableSite("site-x.example.com"),
    ).resolves.toMatchObject({
      site: { id: "site-x-id" },
    });
  });

  it("authorizes DNS aliases only through visible site metadata", async () => {
    getSiteMeta.mockImplementation(async (domain: string) =>
      domain === "site-x.example.com"
        ? { aliases: ["app.example.com"] }
        : { aliases: ["private.example.com"] },
    );
    await expect(
      requireAccessibleDomainTarget("app.example.com"),
    ).resolves.toMatchObject({ site: { id: "site-x-id" } });
    await expect(
      requireAccessibleDomainTarget("private.example.com"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("applies the same alias and write boundary to non-browser actors", async () => {
    getSiteMeta.mockResolvedValue({ aliases: ["app.example.com"] });
    const actor: PanelActor = {
      user: {
        id: "1",
        username: "user-a",
        canCreateSites: false,
        panelRole: "user",
      },
      cloudPanel: record.cloudPanel,
      authentication: "mcp",
    };

    await expect(
      accessibleDomainTargetForActor(actor, "app.example.com"),
    ).resolves.toMatchObject({ site: { id: "site-x-id" } });
    await expect(
      accessibleDomainTargetForActor(actor, "app.example.com", {
        write: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });
});
