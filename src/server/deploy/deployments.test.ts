import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelActor } from "@/server/auth/site-access";
import type { JobWork } from "@/server/jobs/background-jobs";
import {
  getDeploymentSettings,
  saveDeploymentSettings,
  startDeployment,
  listDeployments,
} from "./deployments";

const mocks = vi.hoisted(() => ({
  user: {
    id: "owner-1",
    username: "admin",
    canCreateSites: true,
    status: true,
  },
  manage: vi.fn(),
  work: undefined as JobWork | undefined,
  getSection: vi.fn(),
  listJobs: vi.fn(),
}));
vi.mock("@/server/cloudpanel", () => ({
  getCloudPanelClient: () => ({
    listSites: async () => [{ id: "site-1", domain: "site.test" }],
    getCurrentUser: async () => mocks.user,
    getSiteSection: mocks.getSection,
    manageSiteSection: mocks.manage,
  }),
}));
vi.mock("@/server/auth/panel-roles", () => ({
  decorateUser: async (user: unknown) => user,
}));
vi.mock("@/server/auth/session", () => ({
  listUserSessions: async () => [{ id: "session-1" }],
  appSecret: () => "test-secret",
}));
vi.mock("@/server/sites/site-meta", () => ({ getSiteMeta: async () => null }));
vi.mock("@/server/system/storage-hygiene", () => ({
  assertDiskGrowthAllowed: async () => undefined,
}));
vi.mock("@/server/jobs/background-jobs", () => ({
  startBackgroundJob: async (
    _actor: unknown,
    _input: unknown,
    work: JobWork,
  ) => {
    mocks.work = work;
    return { id: "job-1", status: "queued" };
  },
  listSiteJobs: (...args: unknown[]) => mocks.listJobs(...args),
}));

const actor: PanelActor = {
  user: { id: "owner-1", username: "admin", canCreateSites: true },
  cloudPanel: { cookies: {}, usernameHint: "admin" },
  authentication: "session",
  credentialId: "session-1",
};
let directory = "";
describe("deployment service", () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "panelavo-deployment-service-"));
    process.env.PANEL_DATA_DIR = directory;
    vi.clearAllMocks();
    mocks.user = {
      id: "owner-1",
      username: "admin",
      canCreateSites: true,
      status: true,
    };
    mocks.manage.mockResolvedValue({ steps: [] });
    mocks.getSection.mockImplementation(async (_session, _domain, section) =>
      section === "git"
        ? { branch: "main" }
        : { groups: [], plan: { id: "compose" } },
    );
  });
  afterEach(async () => {
    delete process.env.PANEL_DATA_DIR;
    await rm(directory, { recursive: true, force: true });
  });
  it("defaults to detected deployment and validates saved custom sequences", async () => {
    expect(await getDeploymentSettings(actor, "site.test")).toMatchObject({
      branch: "main",
      healthPath: "/",
      automationEnabled: false,
      hooks: [],
    });
    const settings = {
      branch: "main",
      healthPath: "/health",
      automationEnabled: false,
      hooks: [{ command: "python-create-venv" }, { command: "python-install" }],
    };
    await saveDeploymentSettings(actor, "site.test", settings);
    expect(mocks.manage).toHaveBeenCalledWith(
      actor.cloudPanel,
      "site.test",
      "actions",
      {
        action: "validate-deployment",
        healthPath: "/health",
        deployOperations: settings.hooks,
      },
    );
    expect(await getDeploymentSettings(actor, "site.test")).toMatchObject(
      settings,
    );
  });
  it("keeps prior settings when sequence validation fails", async () => {
    await saveDeploymentSettings(actor, "site.test", {
      branch: "main",
      hooks: [],
    });
    mocks.manage.mockRejectedValueOnce(new Error("Missing Python environment"));
    await expect(
      saveDeploymentSettings(actor, "site.test", {
        branch: "other",
        hooks: [{ command: "python-install" }],
      }),
    ).rejects.toThrow("Missing Python");
    expect(await getDeploymentSettings(actor, "site.test")).toMatchObject({
      branch: "main",
      hooks: [],
    });
  });
  it("disallows unconfigured automation and branch overrides", async () => {
    await expect(
      startDeployment(
        { ...actor, authentication: "api-token" },
        "site.test",
        { branch: "main", expectedCommit: "a".repeat(40) },
        "request-123",
      ),
    ).rejects.toMatchObject({ status: 403 });
    await saveDeploymentSettings(actor, "site.test", {
      branch: "main",
      hooks: [],
    });
    await expect(
      startDeployment(actor, "site.test", { branch: "other" }, "request-123"),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("revalidates live identity before executing queued work", async () => {
    const queued = await startDeployment(
      actor,
      "site.test",
      { source: "current" },
      "request-123",
    );
    expect(queued.status).toBe("queued");
    mocks.user.id = "replacement-user";
    await expect(
      mocks.work!({
        signal: new AbortController().signal,
        progress: async () => undefined,
        log: async () => undefined,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(mocks.manage).not.toHaveBeenCalled();
  });
  it("returns status without step output to read-only users", async () => {
    mocks.listJobs.mockResolvedValue([
      {
        id: "job",
        kind: "Deploy",
        status: "failed",
        createdAt: "today",
        result: { secret: "private output" },
        progress: [{ output: "private" }],
      },
    ]);
    const response = await listDeployments(
      { ...actor, user: { ...actor.user, canCreateSites: false } },
      "site.test",
    );
    expect(JSON.stringify(response)).not.toContain("private");
    expect(mocks.listJobs).toHaveBeenCalledWith("site-1", "site.test");
  });
});
