import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "@/server/cloudpanel/errors";

function dataDirectory() {
  return process.env.PANEL_DATA_DIR || join(process.cwd(), ".data");
}

function encryptionKey() {
  const secret =
    process.env.CREDENTIALS_ENCRYPTION_KEY || process.env.SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw new AppError(
      "INTERNAL_ERROR",
      "Credential encryption is not configured.",
      503,
    );
  return createHash("sha256").update(secret).digest();
}

export function encryptedJsonStore<T>(filename: string, fallback: () => T) {
  const file = () => join(dataDirectory(), filename);
  let saveQueue: Promise<unknown> = Promise.resolve();
  return {
    async load(): Promise<T> {
      try {
        const payload = JSON.parse(await readFile(file(), "utf8")) as {
          iv: string;
          tag: string;
          data: string;
        };
        const decipher = createDecipheriv(
          "aes-256-gcm",
          encryptionKey(),
          Buffer.from(payload.iv, "base64"),
        );
        decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
        return JSON.parse(
          Buffer.concat([
            decipher.update(Buffer.from(payload.data, "base64")),
            decipher.final(),
          ]).toString("utf8"),
        ) as T;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback();
        throw error;
      }
    },
    save(value: T) {
      const operation = saveQueue.then(async () => {
        await mkdir(dataDirectory(), { recursive: true, mode: 0o700 });
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
        const data = Buffer.concat([
          cipher.update(JSON.stringify(value)),
          cipher.final(),
        ]);
        const temporary = `${file()}.${randomUUID()}.tmp`;
        await writeFile(
          temporary,
          JSON.stringify({
            iv: iv.toString("base64"),
            tag: cipher.getAuthTag().toString("base64"),
            data: data.toString("base64"),
          }),
          { mode: 0o600 },
        );
        await rename(temporary, file());
      });
      saveQueue = operation.catch(() => undefined);
      return operation;
    },
  };
}
