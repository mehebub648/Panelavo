import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPanelSettings } from "./store";

describe("panel settings defaults", () => {
  let directory: string;
  const environmentNames = [
    "PANEL_BASE_DOMAIN",
    "PANEL_UPDATE_REPOSITORY",
    "PANEL_WILDCARD_REGISTRATION_ENDPOINT",
    "PANEL_WILDCARD_REGISTRATION_BASE_DOMAIN",
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
      updateRepository: "",
      wildcardRegistrationEndpoint: "",
      wildcardRegistrationBaseDomain: "",
    });
  });

  it("uses explicit environment seeds", async () => {
    process.env.PANEL_BASE_DOMAIN = "Example.COM";
    process.env.PANEL_UPDATE_REPOSITORY =
      "https://git.example.com/panelavo.git";
    process.env.PANEL_WILDCARD_REGISTRATION_ENDPOINT =
      "https://dns.example.com/register";
    process.env.PANEL_WILDCARD_REGISTRATION_BASE_DOMAIN = "Example.COM";

    await expect(getPanelSettings()).resolves.toEqual({
      baseDomain: "example.com",
      updateRepository: "https://git.example.com/panelavo.git",
      wildcardRegistrationEndpoint: "https://dns.example.com/register",
      wildcardRegistrationBaseDomain: "example.com",
    });
  });
});
