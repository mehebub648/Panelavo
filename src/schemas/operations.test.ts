import { describe, expect, it } from "vitest";
import {
  backupRequestSchema,
  envRequestSchema,
  operationsRequestSchema,
  terminalRequestSchema,
} from "./operations";

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
      envRequestSchema.parse({ action: "save", file: "../.bashrc", entries: [] }),
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
