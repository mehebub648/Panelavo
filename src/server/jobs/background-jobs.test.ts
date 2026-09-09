import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startBackgroundJob,
  listSiteJobs,
  getMcpJob,
  boundedResult,
} from "./background-jobs";
import type { PanelActor } from "@/server/auth/site-access";

const actor: PanelActor = {
  user: { id: "owner", username: "owner", canCreateSites: true },
  cloudPanel: { cookies: {} },
  authentication: "fleet",
  credentialId: "connection",
};
let directory = "";
const input = {
  domain: "site.test",
  siteId: "site-1",
  access: "site" as const,
  kind: "deployment",
  timeoutSeconds: 30,
  cancellable: false,
  idempotencyKey: "request-123",
  request: { branch: "main" },
};
async function finished() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [job] = await listSiteJobs("site-1", "site.test");
    if (job?.finishedAt) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Job did not finish");
}
describe("shared deployment jobs", () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "panelavo-deployment-jobs-"));
    process.env.PANEL_DATA_DIR = directory;
  });
  afterEach(async () => {
    delete process.env.PANEL_DATA_DIR;
    await rm(directory, { recursive: true, force: true });
  });
  it("persists source success and build failure with bounded redacted output", async () => {
    await startBackgroundJob(actor, input, async ({ progress }) => {
      await progress({
        type: "source",
        label: "Files updated",
        status: "succeeded",
        commit: "a".repeat(40),
      });
      return {
        source: { commit: "a".repeat(40) },
        deployment: {
          exitCode: 1,
          steps: [
            {
              label: "Build",
              exitCode: 1,
              output: "token=private-secret\n" + "x".repeat(100_000),
            },
          ],
        },
      };
    });
    const job = await finished();
    expect(job.status).toBe("failed");
    expect(job.progress?.[0].commit).toHaveLength(40);
    const saved = JSON.stringify(job.result);
    expect(saved).toContain("Build");
    expect(saved).toContain("Output truncated");
    expect(saved).not.toContain("private-secret");
    expect(saved.length).toBeLessThan(65_536);
    expect(
      JSON.parse(await readFile(join(directory, "mcp-jobs.json"), "utf8"))
        .jobs[0].status,
    ).toBe("failed");
  });
  it("keeps the final failure after many large successful outputs", () => {
    const result = boundedResult({
      deployment: {
        exitCode: 7,
        steps: Array.from({ length: 11 }, (_, index) => ({
          label: `Step ${index}`,
          exitCode: index === 10 ? 7 : 0,
          output:
            "界".repeat(100_000) +
            (index === 10 ? "Final build diagnostic" : "Success"),
        })),
      },
    }) as {
      deployment: {
        exitCode: number;
        steps: { output: string; exitCode: number }[];
      };
    };
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      65_536,
    );
    expect(result.deployment.steps[10]).toMatchObject({ exitCode: 7 });
    expect(result.deployment.steps[10].output).toContain(
      "Final build diagnostic",
    );
  });
  it("deduplicates submissions and rejects conflicting keys and concurrent jobs", async () => {
    let release!: () => void;
    let calls = 0;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job = await startBackgroundJob(actor, input, async () => {
      calls++;
      await pending;
      return {};
    });
    const same = await startBackgroundJob(actor, input, async () => {
      throw new Error("must not execute twice");
    });
    expect(same.id).toBe(job.id);
    await expect(
      startBackgroundJob(
        actor,
        { ...input, request: { branch: "other" } },
        async () => ({}),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      startBackgroundJob(
        actor,
        { ...input, idempotencyKey: "another-request" },
        async () => ({}),
      ),
    ).rejects.toMatchObject({ code: "OPERATION_BUSY" });
    release();
    await finished();
    expect(calls).toBe(1);
    await expect(listSiteJobs("different-site", "site.test")).resolves.toEqual(
      [],
    );
    await expect(
      getMcpJob({ ...actor, authentication: "mcp" }, job.id),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("marks persisted active work interrupted without replay", async () => {
    await writeFile(
      join(directory, "mcp-jobs.json"),
      JSON.stringify({
        jobs: [
          {
            ...input,
            id: "old",
            ownerUserId: actor.user.id,
            credentialId: "connection",
            status: "running",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            logs: [],
          },
        ],
      }),
    );
    const [job] = await listSiteJobs("site-1", "site.test");
    expect(job.status).toBe("interrupted");
    expect(job.error).toContain("restarted");
  });
});
