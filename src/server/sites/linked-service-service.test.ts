import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelActor } from "@/server/auth/site-access";

const mocks = vi.hoisted(() => ({
  accessibleSiteForActor: vi.fn(),
  writableSiteForActor: vi.fn(),
  getBaseDomain: vi.fn(),
  getAllSiteMeta: vi.fn(),
  getLinkedServiceMeta: vi.fn(),
  allocateSiteId: vi.fn(),
  setSiteMeta: vi.fn(),
  removeSiteMeta: vi.fn(),
  planSiteSsl: vi.fn(),
  issueSiteSsl: vi.fn(),
  createSite: vi.fn(),
  assignSite: vi.fn(),
  deleteSite: vi.fn(),
  manageSiteSection: vi.fn(),
}));

vi.mock("@/server/auth/site-access", () => ({
  accessibleSiteForActor: mocks.accessibleSiteForActor,
  writableSiteForActor: mocks.writableSiteForActor,
}));
vi.mock("@/server/settings/store", () => ({
  getBaseDomain: mocks.getBaseDomain,
}));
vi.mock("@/server/sites/ensure-ssl", () => ({
  planSiteSsl: mocks.planSiteSsl,
  issueSiteSsl: mocks.issueSiteSsl,
}));
vi.mock("@/server/sites/site-meta", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server/sites/site-meta")>();
  return {
    ...actual,
    allocateSiteId: mocks.allocateSiteId,
    getAllSiteMeta: mocks.getAllSiteMeta,
    getLinkedServiceMeta: mocks.getLinkedServiceMeta,
    setSiteMeta: mocks.setSiteMeta,
    removeSiteMeta: mocks.removeSiteMeta,
  };
});

import {
  createLinkedServiceForActor,
  listLinkedServicesForActor,
} from "./linked-service-service";

const actor: PanelActor = {
  user: {
    id: "user-1",
    username: "admin",
    canCreateSites: true,
    panelRole: "admin" as const,
  },
  cloudPanel: { cookies: {}, usernameHint: "admin" },
  authentication: "mcp",
};

const client = {
  createSite: mocks.createSite,
  assignSite: mocks.assignSite,
  deleteSite: mocks.deleteSite,
  manageSiteSection: mocks.manageSiteSection,
};

describe("actor-aware linked services", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const access = {
      site: { id: "parent-1", domain: "parent.example.test" },
      sites: [
        { id: "parent-1", domain: "parent.example.test", appPort: 22001 },
        {
          id: "child-1",
          domain: "service.example.test",
          reverseProxyUrl: "http://127.0.0.1:8080",
          status: "active",
        },
      ],
      client,
    };
    mocks.accessibleSiteForActor.mockResolvedValue(access);
    mocks.writableSiteForActor.mockResolvedValue(access);
    mocks.getBaseDomain.mockResolvedValue("sslip.io");
    mocks.getLinkedServiceMeta.mockResolvedValue({});
    mocks.getAllSiteMeta.mockResolvedValue({
      "parent.example.test": {
        id: 22001,
        category: "business",
        aliases: [],
        block: "none",
      },
    });
    mocks.planSiteSsl.mockResolvedValue({ san: [], warnings: [] });
    mocks.issueSiteSsl.mockResolvedValue(undefined);
  });

  it("lists child metadata while marking current CloudPanel visibility", async () => {
    mocks.getLinkedServiceMeta.mockResolvedValue({
      "service.example.test": {
        id: 22002,
        category: "business",
        aliases: ["api.example.test"],
        block: "none",
        parent: "parent.example.test",
        serviceName: "api",
      },
      "hidden.example.test": {
        id: 22003,
        category: "business",
        aliases: [],
        block: "none",
        parent: "parent.example.test",
        serviceName: "worker",
      },
    });

    await expect(
      listLinkedServicesForActor(actor, "parent.example.test"),
    ).resolves.toEqual({
      services: [
        expect.objectContaining({
          domain: "service.example.test",
          serviceName: "api",
          accessible: true,
        }),
        expect.objectContaining({
          domain: "hidden.example.test",
          serviceName: "worker",
          accessible: false,
        }),
      ],
    });
  });

  it("rejects a target port reserved by another website before creation", async () => {
    mocks.getAllSiteMeta.mockResolvedValue({
      "parent.example.test": {
        id: 22001,
        category: "business",
        aliases: [],
        block: "none",
      },
      "other.example.test": {
        id: 22005,
        category: "business",
        aliases: [],
        block: "none",
      },
    });

    await expect(
      createLinkedServiceForActor(
        actor,
        "parent.example.test",
        { serviceName: "api", targetPort: 22005, aliases: [] },
        { serverIp: "203.0.113.10" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 409 });
    expect(mocks.createSite).not.toHaveBeenCalled();
  });
});
