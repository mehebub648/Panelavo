import { describe, expect, it } from "vitest";
import {
  backupRequestSchema,
  envRequestSchema,
  gitRequestSchema,
  operationsRequestSchema,
  terminalRequestSchema,
} from "./operations";

describe("gitRequestSchema", () => {
  it("accepts bounded branch, import and conflict recovery actions", () => {
    for (const action of ["create-branch", "checkout", "set-upstream", "merge"]) {
      expect(gitRequestSchema.parse({ action, branch: "origin/release/v1" })).toEqual({ action, branch: "origin/release/v1" });
    }
    expect(gitRequestSchema.parse({ action: "clone", url: "https://example.test/app.git", preserveExisting: true })).toMatchObject({ preserveExisting: true });
    for (const choice of ["ours", "theirs", "working"]) {
      expect(gitRequestSchema.parse({ action: "resolve-conflict", path: "src/page.tsx", choice })).toMatchObject({ choice });
    }
    for (const action of ["continue", "abort"]) expect(gitRequestSchema.parse({ action })).toEqual({ action });
  });

  it("rejects force options, unsafe branch names and arbitrary recovery commands", () => {
    for (const branch of ["--force", "main..other", "a//b", "a.lock", "/main"]) {
      expect(gitRequestSchema.safeParse({ action: "create-branch", branch }).success).toBe(false);
    }
    for (const operation of [
      { action: "checkout", branch: "main", force: true },
      { action: "clone", url: "https://example.test/app.git", preserveExisting: "yes" },
      { action: "resolve-conflict", path: "file\0.txt", choice: "working" },
      { action: "resolve-conflict", path: "file.txt", choice: "shell" },
      { action: "abort", command: "reset --hard" },
    ]) expect(gitRequestSchema.safeParse(operation).success).toBe(false);
  });
});

describe("operationsRequestSchema", () => {
  it("accepts allow-listed actions and deployment plan identifiers", () => {
    expect(
      operationsRequestSchema.parse({
        action: "run",
        command: "node-run",
        script: "build:production",
      }),
    ).toEqual({
      action: "run",
      command: "node-run",
      script: "build:production",
    });
    expect(
      operationsRequestSchema.parse({ action: "deploy", plan: "compose" }),
    ).toEqual({ action: "deploy", plan: "compose" });
    expect(
      operationsRequestSchema.parse({
        action: "run",
        command: "compose-deploy",
      }),
    ).toEqual({ action: "run", command: "compose-deploy" });
    expect(
      operationsRequestSchema.parse({
        action: "run",
        command: "prepare-rootless-migration",
        name: "web",
      }),
    ).toEqual({
      action: "run",
      command: "prepare-rootless-migration",
      name: "web",
    });
  });

  it("rejects arbitrary commands, arguments, and unknown fields", () => {
    expect(() =>
      operationsRequestSchema.parse({ action: "run", command: "shell" }),
    ).toThrow();
    expect(() =>
      operationsRequestSchema.parse({
        action: "run",
        command: "compose-up",
        args: ["--privileged"],
      }),
    ).toThrow();
    expect(() =>
      operationsRequestSchema.parse({
        action: "deploy",
        plan: "anything",
      }),
    ).toThrow();
  });

  it("accepts only allow-listed fix identifiers", () => {
    expect(
      operationsRequestSchema.parse({ action: "fix", fix: "install-docker" }),
    ).toEqual({ action: "fix", fix: "install-docker" });
    expect(
      operationsRequestSchema.parse({
        action: "fix",
        fix: "initialize-rootless-docker",
      }),
    ).toEqual({ action: "fix", fix: "initialize-rootless-docker" });
    expect(
      operationsRequestSchema.parse({
        action: "fix",
        fix: "align-application-port",
      }),
    ).toEqual({ action: "fix", fix: "align-application-port" });
    expect(() =>
      operationsRequestSchema.parse({ action: "fix", fix: "install-anything" }),
    ).toThrow();
    expect(() =>
      operationsRequestSchema.parse({
        action: "fix",
        fix: "install-docker",
        args: ["--force"],
      }),
    ).toThrow();
  });

  it("requires the matching script or process target and rejects extras", () => {
    expect(() =>
      operationsRequestSchema.parse({ action: "run", command: "node-run" }),
    ).toThrow();
    expect(() =>
      operationsRequestSchema.parse({
        action: "run",
        command: "pm2-stop-one",
      }),
    ).toThrow();
    expect(() =>
      operationsRequestSchema.parse({
        action: "run",
        command: "compose-ps",
        name: "unexpected",
      }),
    ).toThrow();
    expect(() =>
      operationsRequestSchema.parse({
        action: "run",
        command: "prepare-rootless-migration",
      }),
    ).toThrow();
    expect(() =>
      operationsRequestSchema.parse({
        action: "run",
        command: "cutover-rootless-migration",
        name: "unexpected",
      }),
    ).toThrow();
  });
});

describe("envRequestSchema", () => {
  it("accepts a bounded quick-fix upsert", () => {
    expect(
      envRequestSchema.parse({
        action: "upsert",
        entries: [{ key: "HOST_DATA_DIR", value: "/srv/app/data" }],
      }),
    ).toEqual({
      action: "upsert",
      entries: [{ key: "HOST_DATA_DIR", value: "/srv/app/data" }],
    });
  });

  it("rejects empty or invalid quick-fix entries", () => {
    expect(() =>
      envRequestSchema.parse({ action: "upsert", entries: [] }),
    ).toThrow();
    expect(() =>
      envRequestSchema.parse({
        action: "upsert",
        entries: [{ key: "BAD KEY", value: "value" }],
      }),
    ).toThrow();
  });
});

describe("envRequestSchema", () => {
  it("accepts a save to an allow-listed dotenv file", () => {
    expect(
      envRequestSchema.parse({
        action: "save",
        file: ".env",
        entries: [{ key: "APP_KEY", value: "secret value" }],
        syncProfile: true,
      }),
    ).toEqual({
      action: "save",
      file: ".env",
      entries: [{ key: "APP_KEY", value: "secret value" }],
      syncProfile: true,
    });
  });

  it("rejects other files, invalid keys, and multiline values", () => {
    expect(() =>
      envRequestSchema.parse({
        action: "save",
        file: "../.bashrc",
        entries: [],
      }),
    ).toThrow();
    expect(() =>
      envRequestSchema.parse({
        action: "save",
        file: ".env",
        entries: [{ key: "1BAD KEY", value: "x" }],
      }),
    ).toThrow();
    expect(() =>
      envRequestSchema.parse({
        action: "save",
        file: ".env",
        entries: [{ key: "APP_KEY", value: "a\nb" }],
      }),
    ).toThrow();
  });
});

describe("terminalRequestSchema", () => {
  it("accepts a bounded command with an optional working directory", () => {
    expect(
      terminalRequestSchema.parse({
        action: "exec",
        command: "ls -la",
        cwd: "/home/site/htdocs/app",
      }),
    ).toEqual({
      action: "exec",
      command: "ls -la",
      cwd: "/home/site/htdocs/app",
    });
  });

  it("rejects empty, oversized, or NUL-containing commands and extras", () => {
    expect(() =>
      terminalRequestSchema.parse({ action: "exec", command: "" }),
    ).toThrow();
    expect(() =>
      terminalRequestSchema.parse({
        action: "exec",
        command: "x".repeat(4001),
      }),
    ).toThrow();
    expect(() =>
      terminalRequestSchema.parse({ action: "exec", command: "ls\0" }),
    ).toThrow();
    expect(() =>
      terminalRequestSchema.parse({
        action: "exec",
        command: "ls",
        asRoot: true,
      }),
    ).toThrow();
  });
});

describe("backupRequestSchema", () => {
  it("accepts create, delete, and restore with valid identifiers", () => {
    expect(
      backupRequestSchema.parse({
        action: "create",
        files: true,
        databases: ["app-db", "cache_db"],
        note: "before migration",
      }),
    ).toEqual({
      action: "create",
      files: true,
      databases: ["app-db", "cache_db"],
      note: "before migration",
    });
    expect(
      backupRequestSchema.parse({ action: "delete", id: "20260712-153000" }),
    ).toEqual({ action: "delete", id: "20260712-153000" });
    expect(
      backupRequestSchema.parse({
        action: "restore",
        id: "20260712-153000",
        scope: "files",
      }),
    ).toEqual({ action: "restore", id: "20260712-153000", scope: "files" });
  });

  it("rejects bad ids, database names, scopes, and extra fields", () => {
    expect(() =>
      backupRequestSchema.parse({ action: "delete", id: "../etc/passwd" }),
    ).toThrow();
    expect(() =>
      backupRequestSchema.parse({
        action: "create",
        databases: ["bad name;drop"],
      }),
    ).toThrow();
    expect(() =>
      backupRequestSchema.parse({
        action: "restore",
        id: "20260712-153000",
        scope: "everything",
      }),
    ).toThrow();
    expect(() =>
      backupRequestSchema.parse({
        action: "create",
        target: "/etc",
      }),
    ).toThrow();
  });
});
