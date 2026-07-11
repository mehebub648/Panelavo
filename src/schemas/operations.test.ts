import { describe, expect, it } from "vitest";
import { operationsRequestSchema } from "./operations";

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
