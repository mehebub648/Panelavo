import { describe, expect, it } from "vitest";
import {
  classifyUpdate,
  compareReleaseVersions,
  isUpdateCurrent,
  shouldCompleteUpdateHandoff,
} from "./panel-updater";

describe("release comparison", () => {
  it("compares stable semantic versions numerically", () => {
    expect(compareReleaseVersions("0.1.108", "0.1.107")).toBe(1);
    expect(compareReleaseVersions("0.1.95", "0.1.107")).toBe(-1);
    expect(compareReleaseVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareReleaseVersions("unknown", "1.0.0")).toBeUndefined();
  });

  it("blocks a repository release older than the installed version", () => {
    expect(
      classifyUpdate({
        currentVersion: "0.1.108",
        installedCommit: "newer",
        remoteVersion: "0.1.107",
        remoteCommit: "older",
        installedBrokerProtocol: 22,
        requiredBrokerProtocol: 21,
        brokerState: "healthy",
      }),
    ).toMatchObject({ status: "ahead" });
  });

  it("blocks different commits that reuse the installed version", () => {
    expect(
      classifyUpdate({
        currentVersion: "0.1.108",
        installedCommit: "one",
        remoteVersion: "0.1.108",
        remoteCommit: "two",
        installedBrokerProtocol: 22,
        requiredBrokerProtocol: 22,
        brokerState: "healthy",
      }),
    ).toMatchObject({ status: "diverged" });
  });

  it("blocks a newer release until its exact broker protocol is healthy", () => {
    expect(
      classifyUpdate({
        currentVersion: "0.1.108",
        installedCommit: "one",
        remoteVersion: "0.1.109",
        remoteCommit: "two",
        installedBrokerProtocol: 22,
        requiredBrokerProtocol: 23,
        brokerState: "healthy",
      }),
    ).toMatchObject({ status: "blocked" });
  });

  it("allows only a newer release with a compatible broker", () => {
    expect(
      classifyUpdate({
        currentVersion: "0.1.108",
        installedCommit: "one",
        remoteVersion: "0.1.109",
        remoteCommit: "two",
        installedBrokerProtocol: 22,
        requiredBrokerProtocol: 22,
        brokerState: "healthy",
      }),
    ).toEqual({ status: "available", notice: undefined });
  });
});

describe("isUpdateCurrent", () => {
  it("uses matching commits even when the persisted status is complete", () => {
    expect(
      isUpdateCurrent({ installedCommit: "abc", remoteCommit: "abc" }),
    ).toBe(true);
  });

  it("requires both commits to be known and equal", () => {
    expect(
      isUpdateCurrent({ installedCommit: "abc", remoteCommit: "def" }),
    ).toBe(false);
    expect(isUpdateCurrent({ installedCommit: "abc" })).toBe(false);
  });
});

describe("update reload handoff", () => {
  it("is completed only by the replacement panel process", () => {
    expect(
      shouldCompleteUpdateHandoff({ status: "reloading", previousPid: 10 }, 10),
    ).toBe(false);
    expect(
      shouldCompleteUpdateHandoff({ status: "reloading", previousPid: 10 }, 11),
    ).toBe(true);
  });

  it("recovers the legacy stuck state after deployment finished", () => {
    expect(
      shouldCompleteUpdateHandoff(
        { status: "updating", installedCommit: "abc", remoteCommit: "abc" },
        11,
      ),
    ).toBe(true);
    expect(
      shouldCompleteUpdateHandoff(
        { status: "updating", installedCommit: "abc", remoteCommit: "def" },
        11,
      ),
    ).toBe(false);
  });
});
