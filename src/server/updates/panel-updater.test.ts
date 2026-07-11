import { describe, expect, it } from "vitest";
import { isUpdateCurrent } from "./panel-updater";

describe("isUpdateCurrent", () => {
  it("uses matching commits even when the persisted status is complete", () => {
    expect(isUpdateCurrent({ installedCommit: "abc", remoteCommit: "abc" })).toBe(true);
  });

  it("requires both commits to be known and equal", () => {
    expect(isUpdateCurrent({ installedCommit: "abc", remoteCommit: "def" })).toBe(false);
    expect(isUpdateCurrent({ installedCommit: "abc" })).toBe(false);
  });
});
