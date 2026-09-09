import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticateApiToken,
  createApiToken,
  listApiTokens,
  revokeApiToken,
  assertDeploymentTokenActive,
} from "./api-tokens";

const live = vi.hoisted(() => ({
  user: {
    id: "owner-1",
    username: "admin",
    canCreateSites: true,
    status: true,
  },
  sites: [{ id: "site-1", domain: "site.test" }],
  beforeUser: undefined as undefined | (() => Promise<void>),
}));
vi.mock("@/server/cloudpanel", () => ({
  getCloudPanelClient: () => ({
    getCurrentUser: async () => {
      await live.beforeUser?.();
      return live.user;
    },
    listSites: async () => live.sites,
  }),
}));
vi.mock("@/server/auth/panel-roles", () => ({
  decorateUser: async (user: unknown) => user,
}));
describe("API tokens", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "panelavo-api-tokens-"));
    process.env.PANEL_DATA_DIR = directory;
    process.env.SESSION_SECRET =
      "test-session-secret-with-at-least-32-characters";
  });
  afterEach(async () => {
    delete process.env.PANEL_DATA_DIR;
    delete process.env.SESSION_SECRET;
    await rm(directory, { recursive: true, force: true });
  });
  it("shows the secret once and persists only public metadata", async () => {
    const created = await createApiToken("admin", {
      name: "CI",
      scopes: ["sites:read"],
      expiresInDays: 30,
    });
    expect(created.token).toMatch(/^pnl_/);
    await expect(listApiTokens("admin")).resolves.toEqual([created.record]);
    await revokeApiToken("admin", created.record.id);
    await expect(listApiTokens("admin")).resolves.toEqual([]);
  });
  it("does not resurrect a token revoked during live authentication", async () => {
    const { token, record } = await createApiToken("admin", {
      name: "CI",
      scopes: ["sites:read"],
    });
    let entered!: () => void, resume!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      resume = resolve;
    });
    live.beforeUser = async () => {
      entered();
      await pending;
    };
    const authentication = authenticateApiToken(
      new Request("https://panel.test", {
        headers: { authorization: `Bearer ${token}` },
      }),
      "sites:read",
    );
    const rejected = expect(authentication).rejects.toMatchObject({
      status: 401,
    });
    await started;
    await revokeApiToken("admin", record.id);
    resume();
    await rejected;
    live.beforeUser = undefined;
    expect(await listApiTokens("admin")).toEqual([]);
  });
  it("restricts deployment tokens to one live site and stable owner", async () => {
    const { token, record } = await createApiToken("admin", {
      name: "deploy",
      scopes: ["deployments:write"],
      deployment: {
        siteId: "site-1",
        domain: "site.test",
        ownerUserId: "owner-1",
      },
    });
    expect(record.expiresAt).toBeTruthy();
    const request = new Request("https://panel.test", {
      headers: { authorization: `Bearer ${token}` },
    });
    await expect(
      authenticateApiToken(request, "deployments:write", "site.test"),
    ).resolves.toMatchObject({ id: record.id });
    await expect(
      authenticateApiToken(request, "deployments:write", "other.test"),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      authenticateApiToken(request, "sites:write"),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      authenticateApiToken(request, "sites:read"),
    ).rejects.toMatchObject({ status: 403 });
    live.sites = [{ id: "replacement-site", domain: "site.test" }];
    await expect(
      authenticateApiToken(request, "deployments:write", "site.test"),
    ).rejects.toMatchObject({ status: 403 });
    live.sites = [{ id: "site-1", domain: "site.test" }];
    live.user.id = "replacement-owner";
    await expect(
      authenticateApiToken(request, "deployments:write", "site.test"),
    ).rejects.toMatchObject({ status: 403 });
    live.user.id = "owner-1";
    await revokeApiToken("admin", record.id);
    await expect(
      assertDeploymentTokenActive(record.id, "owner-1", "site-1"),
    ).rejects.toMatchObject({ status: 403 });
  });
});
