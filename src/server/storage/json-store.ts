import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type JsonStore<T> = {
  load: () => Promise<T>;
  save: (value: T) => Promise<void>;
};

function dataDirectory() {
  return process.env.PANEL_DATA_DIR || join(process.cwd(), ".data");
}

/**
 * Creates a private JSON store with one shared read-fallback and atomic-write
 * policy. Paths are resolved per operation so tests can override PANEL_DATA_DIR
 * after importing a store module.
 */
export function jsonStore<T>(
  filename: string,
  fallback: () => T,
  normalize: (value: unknown) => T = (value) => value as T,
): JsonStore<T> {
  const file = () => join(dataDirectory(), filename);
  let saveQueue: Promise<unknown> = Promise.resolve();

  return {
    async load() {
      try {
        return normalize(JSON.parse(await readFile(file(), "utf8")));
      } catch {
        return fallback();
      }
    },
    save(value) {
      const operation = saveQueue.then(async () => {
        await mkdir(dataDirectory(), { recursive: true, mode: 0o700 });
        const temporary = `${file()}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
        await rename(temporary, file());
      });
      saveQueue = operation.catch(() => undefined);
      return operation;
    },
  };
}
