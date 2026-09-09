import { describe, expect, it } from "vitest";
import {
  ciDeploymentRequestSchema,
  gitReference,
  healthPathSchema,
  redactDeploymentOutput,
} from "./deployment";
describe("deployment input boundaries", () => {
  it.each([
    "--upload-pack=evil",
    "-main",
    "main..other",
    "main/../other",
    ".hidden",
    "main.lock",
    "main//other",
    "main/",
  ])("rejects invalid reference %s", (value) =>
    expect(gitReference.safeParse(value).success).toBe(false),
  );
  it("accepts normal branch names and requires the tested full commit", () => {
    expect(gitReference.parse("release/2026.09")).toBe("release/2026.09");
    expect(
      ciDeploymentRequestSchema.safeParse({
        branch: "main",
        expectedCommit: "abc123",
      }).success,
    ).toBe(false);
    expect(
      ciDeploymentRequestSchema.safeParse({
        branch: "main",
        expectedCommit: "a".repeat(40),
      }).success,
    ).toBe(true);
  });
  it.each([
    "https://other.test/",
    "//other.test/",
    "/health\nHeader: x",
    "/health%0d%0aX",
  ])("rejects unsafe health path %s", (value) =>
    expect(healthPathSchema.safeParse(value).success).toBe(false),
  );
  it("redacts remote credentials and labelled secrets", () =>
    expect(
      redactDeploymentOutput(
        "https://user:sec@ret@git.test/repo https://token@git.test/repo API_KEY=123 Bearer abc123",
      ),
    ).toBe(
      "https://[redacted]@git.test/repo https://[redacted]@git.test/repo API_KEY=[redacted] Bearer [redacted]",
    ));
});
