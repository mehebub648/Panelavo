import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getPanelSettings,
  getSecuritySettings,
  passwordPolicyError,
  setAddressSettings,
} from "./store";

describe("panel settings defaults", () => {
  let directory: string;
  const environmentNames = [
    "PANEL_BASE_DOMAIN",
    "PANEL_UPDATE_REPOSITORY",
  ] as const;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "panel-settings-"));
    process.env.PANEL_DATA_DIR = directory;
    for (const name of environmentNames) delete process.env[name];
  });

  afterEach(async () => {
    delete process.env.PANEL_DATA_DIR;
    for (const name of environmentNames) delete process.env[name];
    await rm(directory, { recursive: true, force: true });
  });

  it("does not inject vendor-owned runtime defaults", async () => {
    await expect(getPanelSettings()).resolves.toEqual({
      baseDomain: "",
      addressMode: "custom",
      updateRepository: "",
    });
  });

  it("uses explicit environment seeds", async () => {
    process.env.PANEL_BASE_DOMAIN = "Example.COM";
    process.env.PANEL_UPDATE_REPOSITORY =
      "https://git.example.com/panelavo.git";
    await expect(getPanelSettings()).resolves.toEqual({
      baseDomain: "example.com",
      addressMode: "custom",
      updateRepository: "https://git.example.com/panelavo.git",
    });
  });

  it("infers and persists address modes compatibly", async () => {
    process.env.PANEL_BASE_DOMAIN = "sslip.io";
    await expect(getPanelSettings()).resolves.toMatchObject({ addressMode: "sslip" });
    delete process.env.PANEL_BASE_DOMAIN;
    await setAddressSettings("custom", "Example.COM");
    await expect(getPanelSettings()).resolves.toMatchObject({
      addressMode: "custom",
      baseDomain: "example.com",
    });
  });
});

describe("password policy", () => {
  const policy = {
    sessionLifetimeMinutes: 60,
    passwordMinLength: 12,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSymbol: true,
  };
  it("accepts a password that satisfies every enabled rule", () => {
    expect(passwordPolicyError("Panelavo-2026!", policy)).toBeNull();
  });
  it("reports the first missing requirement", () => {
    expect(passwordPolicyError("panelavo-2026!", policy)).toBe(
      "Add an uppercase letter.",
    );
  });
  it("accepts printable Unicode and rejects control characters", () => {
    expect(passwordPolicyError("Pānelavo-2026!", policy)).toBeNull();
    expect(passwordPolicyError("Panelavo\n2026!", policy)).toBe(
      "Control characters are not allowed.",
    );
  });
  it("falls back safely when the environment lifetime is malformed", async () => {
    process.env.SESSION_MAX_AGE_SECONDS = "not-a-number";
    await expect(getSecuritySettings()).resolves.toMatchObject({
      sessionLifetimeMinutes: 60,
    });
    delete process.env.SESSION_MAX_AGE_SECONDS;
  });
});
