import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelActor } from "@/server/auth/site-access";

const mocks = vi.hoisted(() => ({
  accessibleSiteForActor: vi.fn(),
  writableSiteForActor: vi.fn(),
  getBaseDomain: vi.fn(),
  getAllSiteMeta: vi.fn(),
  getLinkedServiceMeta: vi.fn(),
  getSiteMeta: vi.fn(),
  allocateSiteId: vi.fn(),
  setSiteMeta: vi.fn(),
  removeSiteMeta: vi.fn(),
  planSiteSsl: vi.fn(),
  issueSiteSsl: vi.fn(),
  createSite: vi.fn(),
  assignSite: vi.fn(),
  deleteSite: vi.fn(),
  manageSiteSection: vi.fn(),
  manageSiteEndpoint: vi.fn(),
  updateSite: vi.fn(),
}));

vi.mock("@/server/auth/site-access", () => ({
  accessibleSiteForActor: mocks.accessibleSiteForActor,
  canWriteSites: () => true,
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
    getSiteMeta: mocks.getSiteMeta,
    setSiteMeta: mocks.setSiteMeta,
    removeSiteMeta: mocks.removeSiteMeta,
  };
});

import {
  createLinkedServiceForActor,
  listLinkedServicesForActor,
  updateProjectEndpointForActor,
  verifyProjectEndpointForActor,
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
  manageSiteEndpoint: mocks.manageSiteEndpoint,
  updateSite: mocks.updateSite,
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
    mocks.getSiteMeta.mockResolvedValue(null);
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
    mocks.allocateSiteId.mockResolvedValue({
      id: 22002,
      category: { id: "business" },
    });
    mocks.createSite.mockResolvedValue({
      id: "child-2",
      domain: "site-22002.203.0.113.10.sslip.io",
      reverseProxyUrl: "http://127.0.0.1:8080",
      url: "https://site-22002.203.0.113.10.sslip.io",
    });
    mocks.manageSiteEndpoint.mockImplementation(
      async (
        _session,
        _domain,
        operation: { action: string; port?: number },
      ) =>
        operation.action === "list"
          ? {
              ports: [
                { port: 8080, address: "127.0.0.1:8080", process: "node" },
                { port: 8081, address: "127.0.0.1:8081", process: "node" },
              ],
              checkedAt: new Date().toISOString(),
            }
          : {
              probe: {
                port: operation.port,
                owned: true,
                loopback: true,
                reachable: true,
                httpStatus: 200,
                detail: "healthy",
              },
              checkedAt: new Date().toISOString(),
            },
    );
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
      ports: [{ port: 8081, address: "127.0.0.1:8081", process: "node" }],
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
        targetPort: 22005,
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

  it("keeps an unavailable port pending without creating a public proxy", async () => {
    mocks.manageSiteEndpoint.mockResolvedValue({
      probe: {
        port: 8081,
        owned: false,
        loopback: false,
        reachable: false,
        detail: "Port 8081 is not listening yet.",
      },
      checkedAt: new Date().toISOString(),
    });

    const result = await createLinkedServiceForActor(
      actor,
      "parent.example.test",
      {
        serviceName: "worker",
        targetPort: 8081,
        aliases: [],
        allowPending: true,
      },
      { serverIp: "203.0.113.10" },
    );

    expect(result.endpoint.status).toBe("pending");
    expect(mocks.createSite).not.toHaveBeenCalled();
    expect(mocks.setSiteMeta).toHaveBeenCalledWith(
      "site-22002.203.0.113.10.sslip.io",
      expect.objectContaining({ targetPort: 8081, pending: true }),
    );
  });

  it("activates only a verified project-owned healthy port", async () => {
    const result = await createLinkedServiceForActor(
      actor,
      "parent.example.test",
      {
        serviceName: "api",
        targetPort: 8081,
        aliases: [],
        allowPending: false,
      },
      { serverIp: "203.0.113.10" },
    );

    expect(result.endpoint.status).toBe("active");
    expect(mocks.createSite).toHaveBeenCalledWith(
      actor.cloudPanel,
      expect.objectContaining({
        type: "reverse-proxy",
        reverseProxyUrl: "http://127.0.0.1:8081",
      }),
    );
  });

  it("updates a pending reservation without publishing it", async () => {
    mocks.getAllSiteMeta.mockResolvedValue({
      "parent.example.test": {
        id: 22001,
        category: "business",
        aliases: [],
        block: "none",
      },
      "pending.example.test": {
        id: 22002,
        category: "business",
        aliases: [],
        block: "none",
        parent: "parent.example.test",
        serviceName: "worker",
        targetPort: 8081,
        pending: true,
      },
    });
    mocks.getLinkedServiceMeta.mockResolvedValue({});
    mocks.getSiteMeta.mockResolvedValueOnce({
      id: 22002,
      category: "business",
      aliases: [],
      block: "none",
      parent: "parent.example.test",
      serviceName: "worker",
      targetPort: 8081,
      pending: true,
    });

    const result = await updateProjectEndpointForActor(
      actor,
      "parent.example.test",
      "pending.example.test",
      { targetPort: 8082 },
    );
    expect(result.pending).toBe(true);
    expect(mocks.updateSite).not.toHaveBeenCalled();
  });

  it("activates a pending reservation only after a fresh owned-port check", async () => {
    const pendingMeta = {
      id: 22002,
      category: "business",
      aliases: [],
      block: "none" as const,
      parent: "parent.example.test",
      serviceName: "worker",
      targetPort: 8081,
      pending: true,
    };
    mocks.writableSiteForActor.mockResolvedValue({
      site: { id: "parent-1", domain: "parent.example.test" },
      sites: [{ id: "parent-1", domain: "parent.example.test", appPort: 22001 }],
      client,
    });
    mocks.getSiteMeta.mockResolvedValue(pendingMeta);
    mocks.getAllSiteMeta.mockResolvedValue({
      "parent.example.test": {
        id: 22001,
        category: "business",
        aliases: [],
        block: "none",
      },
      "pending.example.test": pendingMeta,
    });

    const result = await verifyProjectEndpointForActor(
      actor,
      "parent.example.test",
      "pending.example.test",
      { serverIp: "203.0.113.10" },
    );

    expect(result).toMatchObject({ verified: true, activated: true });
    expect(mocks.manageSiteEndpoint).toHaveBeenCalledWith(
      actor.cloudPanel,
      "parent.example.test",
      {
        action: "verify",
        port: 8081,
        endpointDomain: "pending.example.test",
      },
    );
    expect(mocks.createSite).toHaveBeenCalledWith(
      actor.cloudPanel,
      expect.objectContaining({ reverseProxyUrl: "http://127.0.0.1:8081" }),
    );
  });

  it("restores the previous proxy when the post-swap health gate fails", async () => {
    const activeMeta = {
      id: 22002,
      category: "business",
      aliases: [],
      block: "none" as const,
      parent: "parent.example.test",
      serviceName: "api",
      targetPort: 8080,
      pending: false,
    };
    mocks.getSiteMeta.mockResolvedValue(activeMeta);
    mocks.getAllSiteMeta.mockResolvedValue({
      "parent.example.test": {
        id: 22001,
        category: "business",
        aliases: [],
        block: "none",
      },
      "service.example.test": activeMeta,
    });
    mocks.manageSiteEndpoint
      .mockResolvedValueOnce({
        probe: {
          port: 8082,
          owned: true,
          loopback: true,
          reachable: true,
          httpStatus: 200,
          detail: "healthy before swap",
        },
        checkedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        probe: {
          port: 8082,
          owned: true,
          loopback: true,
          reachable: false,
          httpStatus: 503,
          detail: "unhealthy after swap",
        },
        checkedAt: new Date().toISOString(),
      });
    mocks.updateSite.mockResolvedValue({
      id: "child-1",
      domain: "service.example.test",
      reverseProxyUrl: "http://127.0.0.1:8082",
    });

    await expect(
      updateProjectEndpointForActor(
        actor,
        "parent.example.test",
        "service.example.test",
        { targetPort: 8082 },
      ),
    ).rejects.toMatchObject({ code: "SITE_UPDATE_FAILED", status: 502 });
    expect(mocks.updateSite).toHaveBeenNthCalledWith(
      1,
      actor.cloudPanel,
      "service.example.test",
      {
        reverseProxyUrl: "http://127.0.0.1:8082",
        endpointParentDomain: "parent.example.test",
      },
    );
    expect(mocks.updateSite).toHaveBeenNthCalledWith(
      2,
      actor.cloudPanel,
      "service.example.test",
      {
        reverseProxyUrl: "http://127.0.0.1:8080",
        endpointParentDomain: "parent.example.test",
      },
    );
    expect(mocks.setSiteMeta).not.toHaveBeenCalled();
  });
});
