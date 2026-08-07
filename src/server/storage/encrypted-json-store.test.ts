import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptedJsonStore } from "./encrypted-json-store";

describe("encryptedJsonStore", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "panelavo-encrypted-store-"));
    process.env.PANEL_DATA_DIR = directory;
    process.env.CREDENTIALS_ENCRYPTION_KEY = "x".repeat(32);
  });

  afterEach(async () => {
    delete process.env.PANEL_DATA_DIR;
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    await rm(directory, { recursive: true, force: true });
  });

  it("round-trips without writing plaintext", async () => {
    const store = encryptedJsonStore("secret.enc", () => ({ token: "" }));
    await store.save({ token: "never-plaintext" });
    expect(await store.load()).toEqual({ token: "never-plaintext" });
    expect(await readFile(join(directory, "secret.enc"), "utf8")).not.toContain(
      "never-plaintext",
    );
  });
});
