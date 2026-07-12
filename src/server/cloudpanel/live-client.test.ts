import { describe, expect, it } from "vitest";
import { siteSectionBridgeError } from "./live-client";

describe("siteSectionBridgeError", () => {
  it("returns the file-manager upload limit", () => {
    const error = siteSectionBridgeError({
      ok: false,
      code: "UPLOAD_TOO_LARGE",
    });
    expect(error.status).toBe(413);
    expect(error.message).toContain("64 MiB");
  });

  it("explains a non-empty clone target", () => {
    const error = siteSectionBridgeError({
      ok: false,
      code: "DIRECTORY_NOT_EMPTY",
    });
    expect(error.status).toBe(409);
    expect(error.message).toContain("root is not empty");
  });

  it("turns Git authentication output into a safe action", () => {
    const error = siteSectionBridgeError({
      ok: false,
      code: "GIT_FAILED",
      message: "git@github.com: Permission denied (publickey).",
    });
    expect(error.status).toBe(422);
    expect(error.message).toContain("public deployment key");
    expect(error.message).not.toContain("git@github.com");
  });

  it("reports a concurrent operation as a retryable conflict", () => {
    const error = siteSectionBridgeError({
      ok: false,
      code: "OPERATION_BUSY",
    });
    expect(error.status).toBe(409);
    expect(error.message).toContain("already running");
  });

  it("surfaces the bridge's specific reason for a failed change", () => {
    const error = siteSectionBridgeError({
      ok: false,
      code: "SITE_UPDATE_FAILED",
      message: 'Database export failed for "app": clpctl error',
    });
    expect(error.status).toBe(502);
    expect(error.message).toContain("Database export failed");
  });

  it("falls back to a generic message when the bridge sends no detail", () => {
    const error = siteSectionBridgeError({ ok: false, code: "SITE_UPDATE_FAILED" });
    expect(error.status).toBe(502);
    expect(error.message).toBe("CloudPanel could not apply the change.");
  });

  it("does not expose unsafe Compose details returned by the bridge", () => {
    const error = siteSectionBridgeError({
      ok: false,
      code: "UNSAFE_COMPOSE",
      message: "bind mount /etc/shadow",
    });
    expect(error.status).toBe(422);
    expect(error.message).toContain("host safety policy");
    expect(error.message).not.toContain("/etc/shadow");
  });
});
