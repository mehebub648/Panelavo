import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelActor } from "@/server/auth/site-access";

const mocks = vi.hoisted(() => ({
  accessibleSiteForActor: vi.fn(),
  accessibleDomainTargetForActor: vi.fn(),
  writableSiteForActor: vi.fn(),
  manageSiteSection: vi.fn(),
  getSiteMeta: vi.fn(),
  setSiteMeta: vi.fn(),
  resolveDnsStatus: vi.fn(),
  planSiteSsl: vi.fn(),
  issueSiteSsl: vi.fn(),
  certificateAlreadyCovers: vi.fn(),
  assertDomainsPointToServer: vi.fn(),
  autoDeleteDns: vi.fn(),
  getZones: vi.fn(),
  pointDns: vi.fn(),
  pointDnsError: vi.fn(),
}));

vi.mock("@/server/auth/site-access", () => ({
  accessibleSiteForActor: mocks.accessibleSiteForActor,
  accessibleDomainTargetForActor: mocks.accessibleDomainTargetForActor,
  writableSiteForActor: mocks.writableSiteForActor,
}));
vi.mock("@/server/cloudflare/point-dns", () => ({
  pointDns: mocks.pointDns,
  pointDnsError: mocks.pointDnsError,
}));
vi.mock("@/server/cloudflare/store", () => ({ getZones: mocks.getZones }));
vi.mock("@/server/network/auto-dns", () => ({
  autoDeleteDns: mocks.autoDeleteDns,
}));
vi.mock("@/server/network/dns", () => ({
  assertDomainsPointToServer: mocks.assertDomainsPointToServer,
  resolveDnsStatus: mocks.resolveDnsStatus,
}));
vi.mock("@/server/sites/ensure-ssl", () => ({
  certificateAlreadyCovers: mocks.certificateAlreadyCovers,
  issueSiteSsl: mocks.issueSiteSsl,
  planSiteSsl: mocks.planSiteSsl,
}));
vi.mock("@/server/sites/site-meta", () => ({
  getSiteMeta: mocks.getSiteMeta,
  setSiteMeta: mocks.setSiteMeta,
}));

import {
  manageSiteDomainsForActor,
  pointSiteDnsForActor,
} from "./site-domain-service";

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

describe("actor-aware website domains", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const access = {
      site: { id: "site-1", domain: "site.example.test" },
      client: { manageSiteSection: mocks.manageSiteSection },
    };
    mocks.writableSiteForActor.mockResolvedValue(access);
    mocks.accessibleSiteForActor.mockResolvedValue(access);
    mocks.accessibleDomainTargetForActor.mockResolvedValue({
      target: "example.com",
    });
    mocks.getSiteMeta.mockResolvedValue({
      id: 20001,
      category: "sites",
      aliases: [],
      block: "none",
    });
    mocks.manageSiteSection.mockResolvedValue({});
    mocks.setSiteMeta.mockResolvedValue(undefined);
    mocks.resolveDnsStatus.mockResolvedValue([]);
    mocks.planSiteSsl.mockResolvedValue({ san: [], warnings: [] });
    mocks.issueSiteSsl.mockResolvedValue(undefined);
    mocks.autoDeleteDns.mockResolvedValue(undefined);
    mocks.pointDns.mockResolvedValue({
      managed: true,
      primaryOk: true,
      changed: true,
      outcomes: [
        {
          name: "example.com",
          status: "created",
          record: { id: "record-1", name: "example.com" },
        },
      ],
    });
  });

  it.each([true, false])(
    "sets www redirect enabled=%s after accepting the vhost",
    async (enabled) => {
      mocks.getSiteMeta.mockResolvedValue({
        id: 20001,
        category: "sites",
        aliases: ["example.com", "www.example.com"],
        block: "none",
        wwwRedirects: ["example.com"],
      });
      await manageSiteDomainsForActor(
        actor,
        "site.example.test",
        { action: "set-www-redirect", domain: "example.com", enabled },
        "203.0.113.10",
      );
      expect(mocks.manageSiteSection).toHaveBeenCalledWith(
        actor.cloudPanel,
        "site.example.test",
        "domains",
        expect.objectContaining({
          wwwRedirects: enabled ? ["example.com"] : [],
        }),
      );
      expect(mocks.manageSiteSection.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.setSiteMeta.mock.invocationCallOrder[0],
      );
    },
  );

  it.each([
    ["apex", []],
    ["www", ["example.com"]],
    ["both", []],
  ] as const)(
    "sets the %s canonical mode while retaining legacy www compatibility",
    async (mode, legacyRedirects) => {
      mocks.getSiteMeta.mockResolvedValue({
        id: 20001,
        category: "sites",
        aliases: ["example.com", "www.example.com"],
        block: "none",
        wwwRedirects: ["example.com"],
      });

      await manageSiteDomainsForActor(
        actor,
        "site.example.test",
        { action: "set-www-canonical", domain: "example.com", mode },
        "203.0.113.10",
      );

      expect(mocks.manageSiteSection).toHaveBeenCalledWith(
        actor.cloudPanel,
        "site.example.test",
        "domains",
        expect.objectContaining({
          wwwCanonical: { "example.com": mode },
          wwwRedirects: legacyRedirects,
        }),
      );
      expect(mocks.setSiteMeta).toHaveBeenCalledWith(
        "site.example.test",
        expect.objectContaining({
          wwwCanonical: { "example.com": mode },
          wwwRedirects: legacyRedirects,
        }),
      );
    },
  );

  it("rejects redirects without both aliases", async () => {
    await expect(
      manageSiteDomainsForActor(
        actor,
        "site.example.test",
        { action: "set-www-redirect", domain: "example.com", enabled: true },
        "203.0.113.10",
      ),
    ).rejects.toThrow("Add both");
    expect(mocks.manageSiteSection).not.toHaveBeenCalled();
  });

  it("does not save redirect settings after a rejected vhost", async () => {
    mocks.getSiteMeta.mockResolvedValue({
      id: 20001,
      category: "sites",
      aliases: ["example.com", "www.example.com"],
      block: "none",
    });
    mocks.manageSiteSection.mockRejectedValueOnce(new Error("nginx rejected"));
    await expect(
      manageSiteDomainsForActor(
        actor,
        "site.example.test",
        { action: "set-www-redirect", domain: "example.com", enabled: true },
        "203.0.113.10",
      ),
    ).rejects.toThrow("nginx rejected");
    expect(mocks.setSiteMeta).not.toHaveBeenCalled();
  });

  it("removes redirect rules when a paired alias is removed", async () => {
    mocks.getSiteMeta.mockResolvedValue({
      id: 20001,
      category: "sites",
      aliases: ["example.com", "www.example.com"],
      block: "none",
      wwwRedirects: ["example.com"],
    });
    await manageSiteDomainsForActor(
      actor,
      "site.example.test",
      { action: "remove-alias", domain: "www.example.com" },
      "203.0.113.10",
    );
    expect(mocks.manageSiteSection).toHaveBeenCalledWith(
      actor.cloudPanel,
      "site.example.test",
      "domains",
      expect.objectContaining({ wwwRedirects: [] }),
    );
    expect(mocks.autoDeleteDns).not.toHaveBeenCalled();
  });

  it("preserves apex and www DNS records when detaching the apex alias", async () => {
    mocks.getSiteMeta.mockResolvedValue({
      id: 20001,
      category: "sites",
      aliases: ["example.com", "www.example.com"],
      block: "none",
    });

    await manageSiteDomainsForActor(
      actor,
      "site.example.test",
      { action: "remove-alias", domain: "example.com" },
      "203.0.113.10",
    );

    expect(mocks.manageSiteSection).toHaveBeenCalledWith(
      actor.cloudPanel,
      "site.example.test",
      "domains",
      expect.objectContaining({ aliases: ["www.example.com"] }),
    );
    expect(mocks.autoDeleteDns).not.toHaveBeenCalled();
  });

  it.each(["www.example.com", "example.com"])(
    "issues only the selected alias %s without an implicit companion",
    async (alias) => {
      mocks.getSiteMeta.mockResolvedValue({
        id: 20001,
        category: "sites",
        aliases: [alias, "other.example.com"],
        block: "none",
      });

      await manageSiteDomainsForActor(
        actor,
        "site.example.test",
        {
          action: "issue-ssl",
          domains: ["site.example.test", alias, alias, "foreign.example.com"],
        },
        "203.0.113.10",
      );

      expect(mocks.assertDomainsPointToServer).toHaveBeenCalledWith(
        ["site.example.test", alias],
        "203.0.113.10",
        expect.any(Function),
      );
      expect(mocks.issueSiteSsl).toHaveBeenCalledWith(
        actor.cloudPanel,
        "site.example.test",
        [alias],
      );
    },
  );

  it("updates the accepted vhost before committing alias metadata", async () => {
    const result = await manageSiteDomainsForActor(
      actor,
      "site.example.test",
      { action: "add-alias", domain: "www.example.test" },
      "203.0.113.10",
    );

    expect(mocks.manageSiteSection).toHaveBeenCalledWith(
      actor.cloudPanel,
      "site.example.test",
      "domains",
      expect.objectContaining({
        action: "sync",
        aliases: ["www.example.test"],
      }),
    );
    expect(mocks.setSiteMeta).toHaveBeenCalledWith(
      "site.example.test",
      expect.objectContaining({ aliases: ["www.example.test"] }),
    );
    expect(mocks.manageSiteSection.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setSiteMeta.mock.invocationCallOrder[0],
    );
    expect(result.meta).toEqual(
      expect.objectContaining({ aliases: ["www.example.test"] }),
    );
  });

  it("waits for automatic HTTPS before reporting an attached domain complete", async () => {
    let finishIssuance!: () => void;
    mocks.issueSiteSsl.mockImplementation(
      () => new Promise<void>((resolve) => (finishIssuance = resolve)),
    );
    let settled = false;
    const result = manageSiteDomainsForActor(
      actor,
      "site.example.test",
      { action: "add-alias", domain: "www.example.test" },
      "203.0.113.10",
    ).then((value) => {
      settled = true;
      return value;
    });

    await vi.waitFor(() => expect(mocks.issueSiteSsl).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    finishIssuance();

    await expect(result).resolves.toEqual(
      expect.objectContaining({ warnings: [] }),
    );
  });

  it("keeps the attached domain and returns a retry warning when HTTPS fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.issueSiteSsl.mockRejectedValueOnce(new Error("ACME failed"));

    const result = await manageSiteDomainsForActor(
      actor,
      "site.example.test",
      { action: "add-alias", domain: "www.example.test" },
      "203.0.113.10",
    );

    expect(result.meta).toEqual(
      expect.objectContaining({ aliases: ["www.example.test"] }),
    );
    expect(result.warnings.at(-1)).toContain("Recheck DNS & secure");
    expect(errorLog).toHaveBeenCalledOnce();
  });

  it("serves the www companion when an apex add request uses the compatible default", async () => {
    await manageSiteDomainsForActor(
      actor,
      "site.example.test",
      { action: "add-alias", domain: "example.com" },
      "203.0.113.10",
    );

    expect(mocks.manageSiteSection).toHaveBeenCalledWith(
      actor.cloudPanel,
      "site.example.test",
      "domains",
      expect.objectContaining({
        aliases: ["example.com", "www.example.com"],
      }),
    );
    expect(mocks.planSiteSsl).toHaveBeenCalledWith(
      expect.objectContaining({
        aliases: ["example.com", "www.example.com"],
      }),
    );
  });

  it("can serve an apex without its www companion when explicitly disabled", async () => {
    await manageSiteDomainsForActor(
      actor,
      "site.example.test",
      { action: "add-alias", domain: "example.com", includeWww: false },
      "203.0.113.10",
    );

    expect(mocks.manageSiteSection).toHaveBeenCalledWith(
      actor.cloudPanel,
      "site.example.test",
      "domains",
      expect.objectContaining({ aliases: ["example.com"] }),
    );
  });

  it("adds a requested www companion for a valid unrecognized suffix", async () => {
    await manageSiteDomainsForActor(
      actor,
      "site.example.test",
      { action: "add-alias", domain: "example.com.bd", includeWww: true },
      "203.0.113.10",
    );

    expect(mocks.manageSiteSection).toHaveBeenCalledWith(
      actor.cloudPanel,
      "site.example.test",
      "domains",
      expect.objectContaining({
        aliases: ["example.com.bd", "www.example.com.bd"],
      }),
    );
  });

  it("does not commit metadata when the vhost rejects the alias", async () => {
    mocks.manageSiteSection.mockRejectedValueOnce(new Error("nginx rejected"));

    await expect(
      manageSiteDomainsForActor(
        actor,
        "site.example.test",
        { action: "add-alias", domain: "www.example.test" },
        "203.0.113.10",
      ),
    ).rejects.toThrow("nginx rejected");
    expect(mocks.setSiteMeta).not.toHaveBeenCalled();
  });

  it("refuses to remove or delete DNS for a domain that is not an alias", async () => {
    await expect(
      manageSiteDomainsForActor(
        actor,
        "site.example.test",
        { action: "remove-alias", domain: "unrelated.example.test" },
        "203.0.113.10",
      ),
    ).rejects.toThrow("That domain is not an alias of this website.");

    expect(mocks.manageSiteSection).not.toHaveBeenCalled();
    expect(mocks.setSiteMeta).not.toHaveBeenCalled();
    expect(mocks.autoDeleteDns).not.toHaveBeenCalled();
  });

  it("returns the exact DNS hostname outcome", async () => {
    const result = await pointSiteDnsForActor(
      actor,
      "example.com",
      { credentialId: "credential-1", zoneId: "zone-1" },
      "203.0.113.10",
    );

    expect(result.outcomes).toEqual([
      { name: "example.com", status: "created" },
    ]);
  });

  it("explains when no connected Cloudflare zone can manage the hostname", async () => {
    mocks.pointDns.mockResolvedValueOnce({
      managed: false,
      primaryOk: false,
      changed: false,
      outcomes: [{ name: "example.com", status: "failed" }],
    });

    await expect(
      pointSiteDnsForActor(
        actor,
        "example.com",
        { credentialId: "credential-1", zoneId: "zone-1" },
        "203.0.113.10",
      ),
    ).rejects.toThrow("Connect its zone or update DNS at your provider");
  });
});
