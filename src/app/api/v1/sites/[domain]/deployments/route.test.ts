import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST, GET } from "./route";
import { GET as status } from "./[id]/route";
import { createApiToken, revokeApiToken } from "@/server/auth/api-tokens";
import { saveDeploymentSettings } from "@/server/deploy/deployments";
import type { PanelActor } from "@/server/auth/site-access";
const mock = vi.hoisted(() => ({
  manage: vi.fn(),
  user: { id: "owner", username: "admin", canCreateSites: true, status: true },
}));
vi.mock("@/server/cloudpanel", () => ({
  getCloudPanelClient: () => ({
    listSites: async () => [{ id: "site-1", domain: "site.test" }],
    getCurrentUser: async () => mock.user,
    manageSiteSection: mock.manage,
  }),
}));
vi.mock("@/server/auth/panel-roles", () => ({
  decorateUser: async (user: unknown) => user,
}));
vi.mock("@/server/sites/site-meta", () => ({ getSiteMeta: async () => null }));
vi.mock("@/server/system/storage-hygiene", () => ({
  assertDiskGrowthAllowed: async () => undefined,
}));
vi.mock("@/server/security/log", () => ({ audit: async () => undefined }));
let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "panelavo-deployment-api-"));
  process.env.PANEL_DATA_DIR = directory;
  process.env.SESSION_SECRET = "test-only-deployment-api-secret-32-characters";
  mock.manage.mockImplementation(async (_session, _domain, _section, input) =>
    input.action === "validate-deployment"
      ? { steps: [] }
      : {
          source: { status: "updated", commit: input.expectedCommit },
          deployment: {
            exitCode: 7,
            steps: [
              {
                command: "node-run",
                label: "Build application",
                exitCode: 7,
                output: "Build failed: missing entry file",
              },
            ],
          },
        },
  );
});
afterEach(async () => {
  delete process.env.PANEL_DATA_DIR;
  delete process.env.SESSION_SECRET;
  await rm(directory, { recursive: true, force: true });
});
it("submits the tested commit, deduplicates it, persists failure, and enforces revocation", async () => {
  const actor: PanelActor = {
    user: mock.user,
    cloudPanel: { cookies: {}, usernameHint: "admin" },
    authentication: "session",
  };
  await saveDeploymentSettings(actor, "site.test", {
    branch: "main",
    hooks: [],
    automationEnabled: true,
  });
  const { token, record } = await createApiToken("admin", {
    name: "CI",
    scopes: ["deployments:write"],
    deployment: { siteId: "site-1", domain: "site.test", ownerUserId: "owner" },
  });
  const url = "https://panel.test/api/v1/sites/site.test/deployments";
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "idempotency-key": "ci-tested-commit-123",
  };
  const context = { params: Promise.resolve({ domain: "site.test" }) };
  const request = () =>
    new NextRequest(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ branch: "main", expectedCommit: "a".repeat(40) }),
    });
  const response = await POST(request(), context);
  expect(response.status).toBe(202);
  const started = (await response.json()).data;
  const duplicate = await POST(request(), context);
  expect((await duplicate.json()).data.id).toBe(started.id);
  let completed;
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await status(
      new NextRequest(`${url}/${started.id}`, { headers }),
      { params: Promise.resolve({ domain: "site.test", id: started.id }) },
    );
    completed = (await result.json()).data;
    if (completed.finishedAt) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(completed.status).toBe("failed");
  expect(completed.result.source.commit).toBe("a".repeat(40));
  expect(completed.result.deployment.steps[0].output).toContain(
    "missing entry file",
  );
  expect(
    mock.manage.mock.calls.filter((call) => call[3].action === "deployment"),
  ).toHaveLength(1);
  const list = await GET(new NextRequest(url, { headers }), context);
  expect((await list.json()).data.jobs).toHaveLength(1);
  await revokeApiToken("admin", record.id);
  expect((await GET(new NextRequest(url, { headers }), context)).status).toBe(
    401,
  );
});
