import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PanelActor } from "@/server/auth/site-access";
import {
  beginArtifactUpload,
  deleteArtifactUpload,
  getArtifactUpload,
  writeArtifactChunk,
} from "@/server/mcp/artifacts";

function actor(credentialId = "credential-1"): PanelActor {
  return {
    authentication: "mcp",
    credentialId,
    user: {
      id: "42",
      username: "owner",
      role: "admin",
      panelRole: "super-admin",
      status: true,
      canCreateSites: true,
    },
    cloudPanel: { cookie: "test", username: "owner" },
  } as unknown as PanelActor;
}

async function* chunks(...values: Uint8Array[]) {
  yield* values;
}

describe("MCP artifact uploads", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "panelavo-artifacts-"));
    process.env.PANEL_DATA_DIR = directory;
  });

  afterEach(async () => {
    delete process.env.PANEL_DATA_DIR;
    await rm(directory, { recursive: true, force: true });
  });

  it("resumes raw chunks and completes only after checksum verification", async () => {
    const content = Buffer.from("streamed release artifact");
    const expectedSha256 = createHash("sha256").update(content).digest("hex");
    const upload = await beginArtifactUpload(actor(), {
      domain: "site.example.com",
      name: "release.tar.gz",
      expectedBytes: content.length,
      expectedSha256,
    });

    const first = await writeArtifactChunk(actor(), upload.id, {
      start: 0,
      end: 7,
      total: content.length,
      body: chunks(content.subarray(0, 8)),
    });
    expect(first).toMatchObject({ status: "uploading", receivedBytes: 8 });

    const complete = await writeArtifactChunk(actor(), upload.id, {
      start: 8,
      end: content.length - 1,
      total: content.length,
      body: chunks(content.subarray(8)),
    });
    expect(complete).toMatchObject({
      status: "complete",
      receivedBytes: content.length,
      expectedSha256,
    });
    expect((await getArtifactUpload(actor(), upload.id)).status).toBe(
      "complete",
    );
  });

  it("rejects the wrong resume offset without advancing the upload", async () => {
    const content = Buffer.from("abcdef");
    const upload = await beginArtifactUpload(actor(), {
      domain: "site.example.com",
      name: "release.zip",
      expectedBytes: content.length,
      expectedSha256: createHash("sha256").update(content).digest("hex"),
    });
    await expect(
      writeArtifactChunk(actor(), upload.id, {
        start: 2,
        end: 5,
        total: content.length,
        body: chunks(content.subarray(2)),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await getArtifactUpload(actor(), upload.id)).receivedBytes).toBe(0);
  });

  it("fails and removes an artifact whose final checksum differs", async () => {
    const content = Buffer.from("wrong bytes");
    const upload = await beginArtifactUpload(actor(), {
      domain: "site.example.com",
      name: "release.tar.gz",
      expectedBytes: content.length,
      expectedSha256: "a".repeat(64),
    });
    const result = await writeArtifactChunk(actor(), upload.id, {
      start: 0,
      end: content.length - 1,
      total: content.length,
      body: chunks(content),
    });
    expect(result).toMatchObject({
      status: "failed",
      error: "SHA-256 checksum mismatch.",
    });
  });

  it("binds uploads to the MCP credential and supports explicit deletion", async () => {
    const content = Buffer.from("artifact");
    const upload = await beginArtifactUpload(actor(), {
      domain: "site.example.com",
      name: "release.tgz",
      expectedBytes: content.length,
      expectedSha256: createHash("sha256").update(content).digest("hex"),
    });
    await expect(
      getArtifactUpload(actor("another-credential"), upload.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(deleteArtifactUpload(actor(), upload.id)).resolves.toEqual({
      id: upload.id,
      deleted: true,
    });
  });
});
