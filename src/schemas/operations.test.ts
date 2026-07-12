import { describe, expect, it } from "vitest";
import {
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
