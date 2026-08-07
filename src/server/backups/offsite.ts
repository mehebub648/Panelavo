import { createReadStream, createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { z } from "zod";
import { encryptedJsonStore } from "@/server/storage/encrypted-json-store";
import {
  importBackupBundle,
  prepareBackupStaging,
  stageBackupBundle,
} from "@/server/cloudpanel/live-client";
import { getSiteRootOverride } from "@/server/sites/site-root-overlay";
import { AppError } from "@/server/cloudpanel/errors";

export const offsiteDestinationSchema = z
  .object({
    enabled: z.boolean(),
    endpoint: z.string().url().max(500).refine((value) => value.startsWith("https://"), {
      message: "The endpoint must use HTTPS.",
    }),
    region: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
    bucket: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/),
    prefix: z
      .string()
      .max(200)
      .regex(/^[A-Za-z0-9._/-]*$/)
      .refine(
        (value) =>
          !value.split("/").some((part) => part === "." || part === ".."),
        { message: "The object prefix cannot contain traversal segments." },
      ),
    accessKeyId: z.string().min(1).max(256),
    secretAccessKey: z.string().max(512),
    forcePathStyle: z.boolean(),
  })
  .strict();

export type OffsiteDestinationInput = z.infer<typeof offsiteDestinationSchema>;
type Store = { sites: Record<string, OffsiteDestinationInput> };
const store = encryptedJsonStore<Store>("backup-destinations.enc", () => ({
  sites: {},
}));

function publicDestination(value?: OffsiteDestinationInput) {
  if (!value) return null;
  return {
    enabled: value.enabled,
    endpoint: value.endpoint,
    region: value.region,
    bucket: value.bucket,
    prefix: value.prefix,
    accessKeyId: value.accessKeyId,
    hasSecret: Boolean(value.secretAccessKey),
    forcePathStyle: value.forcePathStyle,
  };
}

async function destination(domain: string) {
  return (await store.load()).sites[domain.toLowerCase()];
}

function client(value: OffsiteDestinationInput) {
  return new S3Client({
    endpoint: value.endpoint,
    region: value.region,
    forcePathStyle: value.forcePathStyle,
    credentials: {
      accessKeyId: value.accessKeyId,
      secretAccessKey: value.secretAccessKey,
    },
  });
}

function objectPrefix(domain: string, value: OffsiteDestinationInput) {
  const prefix = value.prefix.replace(/^\/+|\/+$/g, "");
  return `${prefix ? `${prefix}/` : ""}${domain.toLowerCase()}/`;
}

function objectKey(domain: string, id: string, value: OffsiteDestinationInput) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id))
    throw new AppError("INVALID_REQUEST", "The backup id is invalid.", 400);
  return `${objectPrefix(domain, value)}${id}.tar.gz`;
}

export async function getOffsiteDestination(domain: string) {
  return publicDestination(await destination(domain));
}

export async function saveOffsiteDestination(
  domain: string,
  input: OffsiteDestinationInput,
) {
  const value = await store.load();
  const key = domain.toLowerCase();
  const secretAccessKey = input.secretAccessKey || value.sites[key]?.secretAccessKey;
  if (!secretAccessKey)
    throw new AppError("INVALID_REQUEST", "Enter the S3 secret access key.", 400);
  const candidate = { ...input, secretAccessKey };
  await client(candidate).send(
    new ListObjectsV2Command({
      Bucket: candidate.bucket,
      Prefix: objectPrefix(domain, candidate),
      MaxKeys: 1,
    }),
  );
  value.sites[key] = candidate;
  await store.save(value);
  return publicDestination(value.sites[key]);
}

export async function removeOffsiteDestination(domain: string) {
  const value = await store.load();
  delete value.sites[domain.toLowerCase()];
  await store.save(value);
}

export async function listOffsiteBackups(domain: string) {
  const value = await destination(domain);
  if (!value) return [];
  const result = await client(value).send(
    new ListObjectsV2Command({
      Bucket: value.bucket,
      Prefix: objectPrefix(domain, value),
      MaxKeys: 100,
    }),
  );
  return (result.Contents ?? [])
    .map((item) => {
      const name = item.Key?.slice(objectPrefix(domain, value).length) ?? "";
      const id = name.replace(/\.tar\.gz$/, "");
      return /^[A-Za-z0-9-]{1,64}$/.test(id)
        ? {
            id,
            bytes: item.Size ?? 0,
            modifiedAt: item.LastModified?.toISOString() ?? "",
          }
        : null;
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

export async function uploadOffsiteBackup(domain: string, id: string) {
  const value = await destination(domain);
  if (!value?.enabled)
    throw new AppError(
      "INVALID_REQUEST",
      "Enable an off-site destination first.",
      400,
    );
  const staged = await stageBackupBundle({
    domain,
    id,
    applicationRootDirectory: await getSiteRootOverride(domain),
  });
  try {
    await client(value).send(
      new PutObjectCommand({
        Bucket: value.bucket,
        Key: objectKey(domain, id, value),
        Body: createReadStream(staged.path),
        ContentLength: staged.bytes,
        ContentType: "application/gzip",
      }),
    );
  } finally {
    await unlink(staged.path).catch(() => undefined);
  }
}

export async function restoreOffsiteBackup(domain: string, id: string) {
  const value = await destination(domain);
  if (!value)
    throw new AppError("INVALID_REQUEST", "No off-site destination is configured.", 400);
  const staging = await prepareBackupStaging();
  const path = `${staging.directory}/${randomUUID().replaceAll("-", "")}.tar.gz`;
  try {
    const result = await client(value).send(
      new GetObjectCommand({
        Bucket: value.bucket,
        Key: objectKey(domain, id, value),
      }),
    );
    if (!result.Body)
      throw new AppError("SITE_UPDATE_FAILED", "The remote backup was empty.", 502);
    await pipeline(result.Body as Readable, createWriteStream(path, { mode: 0o600 }));
    await importBackupBundle({
      domain,
      id,
      path,
      applicationRootDirectory: await getSiteRootOverride(domain),
    });
  } finally {
    await unlink(path).catch(() => undefined);
  }
}

export async function deleteOffsiteBackup(domain: string, id: string) {
  const value = await destination(domain);
  if (!value) return;
  await client(value).send(
    new DeleteObjectCommand({
      Bucket: value.bucket,
      Key: objectKey(domain, id, value),
    }),
  );
}
