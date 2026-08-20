import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { PanelActor } from "@/server/auth/site-access";
import { AppError } from "@/server/cloudpanel/errors";
import { jsonStore } from "@/server/storage/json-store";

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CHUNK_BYTES = 32 * 1024 * 1024;
const MAX_ACTIVE_UPLOADS = 5;
const MAX_OWNER_BYTES = 4 * 1024 * 1024 * 1024;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export type ArtifactUploadStatus =
  | "uploading"
  | "complete"
  | "failed";

type ArtifactUploadRecord = {
  id: string;
  ownerUserId: string;
  credentialId: string;
  domain: string;
  name: string;
  mediaType?: string;
  expectedBytes: number;
  expectedSha256: string;
  receivedBytes: number;
  status: ArtifactUploadStatus;
  createdAt: string;
  expiresAt: string;
  completedAt?: string;
  error?: string;
};

export type ArtifactUpload = Omit<
  ArtifactUploadRecord,
  "ownerUserId" | "credentialId"
> & {
  uploadPath: string;
  maximumChunkBytes: number;
};

type ArtifactStore = { uploads: ArtifactUploadRecord[] };

const store = jsonStore<ArtifactStore>(
  "mcp-artifacts.json",
  () => ({ uploads: [] }),
  (value) => {
    if (!value || typeof value !== "object") return { uploads: [] };
    const uploads = (value as { uploads?: unknown }).uploads;
    return { uploads: Array.isArray(uploads) ? uploads : [] } as ArtifactStore;
  },
);

let mutationQueue: Promise<unknown> = Promise.resolve();

function dataDirectory() {
  return process.env.PANEL_DATA_DIR || join(process.cwd(), ".data");
}

function artifactDirectory() {
  return join(dataDirectory(), "mcp-artifacts");
}

function artifactPath(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id))
    throw new AppError("INVALID_REQUEST", "Choose a valid artifact upload.", 400);
  return join(artifactDirectory(), `${id}.part`);
}

function actorCredential(actor: PanelActor) {
  if (actor.authentication !== "mcp" || !actor.credentialId)
    throw new AppError(
      "FORBIDDEN",
      "Artifact uploads require an authenticated MCP connection.",
      403,
    );
  return actor.credentialId;
}

function publicUpload(record: ArtifactUploadRecord): ArtifactUpload {
  const { ownerUserId: _owner, credentialId: _credential, ...value } = record;
  return {
    ...value,
    uploadPath: `/api/mcp/artifacts/${record.id}`,
    maximumChunkBytes: MAX_CHUNK_BYTES,
  };
}

async function removeExpired(state: ArtifactStore) {
  const now = Date.now();
  const expired = state.uploads.filter(
    (upload) => new Date(upload.expiresAt).getTime() <= now,
  );
  state.uploads = state.uploads.filter(
    (upload) => new Date(upload.expiresAt).getTime() > now,
  );
  await Promise.all(
    expired.map((upload) => rm(artifactPath(upload.id), { force: true })),
  );
}

function matchingUpload(
  state: ArtifactStore,
  actor: PanelActor,
  id: string,
) {
  const credentialId = actorCredential(actor);
  const upload = state.uploads.find(
    (candidate) =>
      candidate.id === id &&
      candidate.ownerUserId === String(actor.user.id) &&
      candidate.credentialId === credentialId,
  );
  if (!upload)
    throw new AppError("SITE_NOT_FOUND", "Artifact upload not found.", 404);
  return upload;
}

function mutate<T>(work: () => Promise<T>): Promise<T> {
  const operation = mutationQueue.then(work, work);
  mutationQueue = operation.catch(() => undefined);
  return operation;
}

export async function beginArtifactUpload(
  actor: PanelActor,
  input: {
    domain: string;
    name: string;
    mediaType?: string;
    expectedBytes: number;
    expectedSha256: string;
  },
) {
  const credentialId = actorCredential(actor);
  if (
    !Number.isSafeInteger(input.expectedBytes) ||
    input.expectedBytes < 1 ||
    input.expectedBytes > MAX_ARTIFACT_BYTES
  )
    throw new AppError(
      "INVALID_REQUEST",
      "Artifact size must be between 1 byte and 2 GiB.",
      400,
    );
  if (!/^[a-f0-9]{64}$/i.test(input.expectedSha256))
    throw new AppError(
      "INVALID_REQUEST",
      "Provide the artifact's 64-character SHA-256 checksum.",
      400,
    );
  const name = basename(input.name.trim());
  if (
    !name ||
    name !== input.name.trim() ||
    name === "." ||
    name === ".." ||
    name.length > 255
  )
    throw new AppError("INVALID_REQUEST", "Choose a valid artifact name.", 400);

  return mutate(async () => {
    const state = await store.load();
    await removeExpired(state);
    const owned = state.uploads.filter(
      (upload) =>
        upload.ownerUserId === String(actor.user.id) &&
        upload.status !== "failed",
    );
    if (owned.filter((upload) => upload.status === "uploading").length >= MAX_ACTIVE_UPLOADS)
      throw new AppError(
        "OPERATION_BUSY",
        "Finish or delete an existing artifact upload before starting another.",
        409,
      );
    if (
      owned.reduce((total, upload) => total + upload.expectedBytes, 0) +
        input.expectedBytes >
      MAX_OWNER_BYTES
    )
      throw new AppError(
        "INVALID_REQUEST",
        "Active MCP artifacts cannot exceed 4 GiB per account.",
        413,
      );
    const now = Date.now();
    const record: ArtifactUploadRecord = {
      id: randomUUID(),
      ownerUserId: String(actor.user.id),
      credentialId,
      domain: input.domain.toLowerCase(),
      name,
      mediaType: input.mediaType?.trim().slice(0, 200) || undefined,
      expectedBytes: input.expectedBytes,
      expectedSha256: input.expectedSha256.toLowerCase(),
      receivedBytes: 0,
      status: "uploading",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + UPLOAD_TTL_MS).toISOString(),
    };
    state.uploads.push(record);
    await mkdir(artifactDirectory(), { recursive: true, mode: 0o700 });
    await store.save(state);
    return publicUpload(record);
  });
}

export async function getArtifactUpload(actor: PanelActor, id: string) {
  return mutate(async () => {
    const state = await store.load();
    await removeExpired(state);
    const upload = matchingUpload(state, actor, id);
    await store.save(state);
    return publicUpload(upload);
  });
}

export async function deleteArtifactUpload(actor: PanelActor, id: string) {
  return mutate(async () => {
    const state = await store.load();
    const upload = matchingUpload(state, actor, id);
    state.uploads = state.uploads.filter((candidate) => candidate.id !== id);
    await rm(artifactPath(id), { force: true });
    await store.save(state);
    return { id: upload.id, deleted: true };
  });
}

async function sha256File(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function writeArtifactChunk(
  actor: PanelActor,
  id: string,
  input: {
    start: number;
    end: number;
    total: number;
    contentLength?: number;
    body: AsyncIterable<Uint8Array>;
  },
) {
  return mutate(async () => {
    const state = await store.load();
    await removeExpired(state);
    const upload = matchingUpload(state, actor, id);
    if (upload.status !== "uploading")
      throw new AppError(
        "INVALID_REQUEST",
        upload.status === "complete"
          ? "This artifact upload is already complete."
          : "This artifact upload cannot accept more data.",
        409,
      );
    const declaredBytes = input.end - input.start + 1;
    if (
      input.start !== upload.receivedBytes ||
      input.end < input.start ||
      input.total !== upload.expectedBytes ||
      input.end >= input.total ||
      declaredBytes > MAX_CHUNK_BYTES ||
      (input.contentLength !== undefined &&
        input.contentLength !== declaredBytes)
    )
      throw new AppError(
        "INVALID_REQUEST",
        `Resume this upload at byte ${upload.receivedBytes} with a chunk no larger than ${MAX_CHUNK_BYTES} bytes.`,
        409,
      );

    await mkdir(artifactDirectory(), { recursive: true, mode: 0o700 });
    const path = artifactPath(id);
    const file = await open(path, input.start === 0 ? "w" : "r+");
    let written = 0;
    try {
      await file.chmod(0o600);
      for await (const value of input.body) {
        const chunk = Buffer.from(value);
        written += chunk.length;
        if (written > declaredBytes)
          throw new AppError(
            "INVALID_REQUEST",
            "The upload body exceeded its declared byte range.",
            400,
          );
        let chunkOffset = 0;
        const fileOffset = input.start + written - chunk.length;
        while (chunkOffset < chunk.length) {
          const result = await file.write(
            chunk,
            chunkOffset,
            chunk.length - chunkOffset,
            fileOffset + chunkOffset,
          );
          if (result.bytesWritten < 1)
            throw new AppError(
              "SITE_UPDATE_FAILED",
              "The server could not persist the artifact chunk.",
              502,
            );
          chunkOffset += result.bytesWritten;
        }
      }
    } catch (error) {
      await file.truncate(input.start);
      throw error;
    } finally {
      await file.close();
    }
    if (written !== declaredBytes) {
      const repair = await open(path, "r+");
      await repair.truncate(input.start);
      await repair.close();
      throw new AppError(
        "INVALID_REQUEST",
        "The upload body did not match its declared byte range.",
        400,
      );
    }

    upload.receivedBytes += written;
    if (upload.receivedBytes === upload.expectedBytes) {
      const actual = await sha256File(path);
      if (actual !== upload.expectedSha256) {
        upload.status = "failed";
        upload.error = "SHA-256 checksum mismatch.";
        await rm(path, { force: true });
      } else {
        upload.status = "complete";
        upload.completedAt = new Date().toISOString();
      }
    }
    await store.save(state);
    return publicUpload(upload);
  });
}

export function completedArtifactPath(upload: ArtifactUpload) {
  if (upload.status !== "complete")
    throw new AppError(
      "INVALID_REQUEST",
      "Finish the artifact upload before using it.",
      409,
    );
  return artifactPath(upload.id);
}
