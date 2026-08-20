import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PanelActor } from "@/server/auth/site-access";
import { AppError } from "@/server/cloudpanel/errors";
import {
  cancelMcpJob,
  getMcpJob,
  listMcpJobs,
  startMcpJob,
} from "./jobs";

let directory = "";

function actor(credentialId = "credential-1"): PanelActor {
  return {
    user: {
      id: "user-1",
      username: "admin",
      panelRole: "admin",
      canCreateSites: true,
    },
    cloudPanel: { cookies: {}, usernameHint: "admin" },
    authentication: "mcp",
    credentialId,
  };
}

async function waitForStatus(
  subject: PanelActor,
  id: string,
  expected: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await getMcpJob(subject, id);
    if (job.status === expected) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Job ${id} did not reach ${expected}.`);
}

describe("MCP background jobs", () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "panelavo-jobs-"));
    process.env.PANEL_DATA_DIR = directory;
  });

  afterEach(async () => {
    delete process.env.PANEL_DATA_DIR;
    await rm(directory, { recursive: true, force: true });
  });

  it("returns immediately and persists a bounded successful result", async () => {
    const subject = actor();
    const started = await startMcpJob(
      subject,
      { domain: "site.example", kind: "node deployment", timeoutSeconds: 30 },
      async ({ log }) => {
        await log("Building the release.");
        return { deployed: true };
      },
    );

    expect(started.status).toBe("queued");
    const finished = await waitForStatus(subject, started.id, "succeeded");
    expect(finished.result).toEqual({ deployed: true });
    expect(finished.logs.map((entry) => entry.message)).toContain(
      "Building the release.",
    );
    expect((await listMcpJobs(subject, "site.example")).jobs).toHaveLength(1);
  });

  it("cancels the running work through its AbortSignal", async () => {
    const subject = actor();
    const started = await startMcpJob(
      subject,
      { domain: "site.example", kind: "compose deployment", timeoutSeconds: 30 },
      ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                new AppError(
                  "REQUEST_CANCELLED",
                  "The operation was cancelled.",
                  409,
                ),
              ),
            { once: true },
          );
        }),
    );

    await waitForStatus(subject, started.id, "running");
    expect((await cancelMcpJob(subject, started.id)).status).toBe("cancelling");
    const cancelled = await waitForStatus(subject, started.id, "cancelled");
    expect(cancelled.logs.at(-1)?.message).toContain("process was stopped");
  });

  it("isolates jobs by MCP credential and rejects site collisions", async () => {
    const subject = actor();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = await startMcpJob(
      subject,
      { domain: "site.example", kind: "backup", timeoutSeconds: 30 },
      () => pending,
    );
    await waitForStatus(subject, started.id, "running");

    await expect(getMcpJob(actor("credential-2"), started.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      startMcpJob(
        subject,
        { domain: "site.example", kind: "deployment", timeoutSeconds: 30 },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "OPERATION_BUSY" });

    release();
    await waitForStatus(subject, started.id, "succeeded");
  });
});
