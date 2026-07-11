import { describe, expect, it } from "vitest";
import { isUpdateCurrent, shouldCompleteUpdateHandoff } from "./panel-updater";

describe("isUpdateCurrent", () => {
  it("uses matching commits even when the persisted status is complete", () => {
    expect(isUpdateCurrent({ installedCommit: "abc", remoteCommit: "abc" })).toBe(true);
  });

  it("requires both commits to be known and equal", () => {
    expect(isUpdateCurrent({ installedCommit: "abc", remoteCommit: "def" })).toBe(false);
    expect(isUpdateCurrent({ installedCommit: "abc" })).toBe(false);
  });
});

describe("update reload handoff", () => {
  it("is completed only by the replacement panel process", () => {
    expect(shouldCompleteUpdateHandoff({ status: "reloading", previousPid: 10 }, 10)).toBe(false);
    expect(shouldCompleteUpdateHandoff({ status: "reloading", previousPid: 10 }, 11)).toBe(true);
  });

  it("recovers the legacy stuck state after deployment finished", () => {
    expect(shouldCompleteUpdateHandoff({ status: "updating", installedCommit: "abc", remoteCommit: "abc" }, 11)).toBe(true);
    expect(shouldCompleteUpdateHandoff({ status: "updating", installedCommit: "abc", remoteCommit: "def" }, 11)).toBe(false);
  });
});
