import { describe, expect, it } from "vitest";
import { siteSectionBridgeError } from "./live-client";

describe("siteSectionBridgeError", () => {
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
});
