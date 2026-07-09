import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cloudRoleFor,
  decorateUser,
  isPanelAdmin,
  setPanelAdmin,
} from "./panel-roles";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "panel-roles-"));
  process.env.PANEL_DATA_DIR = dir;
});

afterAll(() => {
  delete process.env.PANEL_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("panel role overlay", () => {
  it("persists and removes panel admins case-insensitively", async () => {
    expect(await isPanelAdmin("dana")).toBe(false);
    await setPanelAdmin("Dana", true);
    expect(await isPanelAdmin("dana")).toBe(true);
    expect(await isPanelAdmin("DANA")).toBe(true);
    await setPanelAdmin("dana", false);
    expect(await isPanelAdmin("dana")).toBe(false);
  });

  it("maps panel roles to CloudPanel roles", () => {
    expect(cloudRoleFor("super-admin")).toBe("admin");
    expect(cloudRoleFor("manager")).toBe("site-manager");
    expect(cloudRoleFor("admin")).toBe("user");
    expect(cloudRoleFor("user")).toBe("user");
  });

  it("decorates CloudPanel admins as super admins", async () => {
    const user = await decorateUser({
      id: "1",
      username: "root",
      role: "admin",
      canCreateSites: true,
    });
    expect(user.panelRole).toBe("super-admin");
    expect(user.canCreateSites).toBe(true);
  });

  it("decorates site managers as managers", async () => {
    const user = await decorateUser({
      id: "2",
      username: "mgr",
      role: "site-manager",
      canCreateSites: true,
    });
    expect(user.panelRole).toBe("manager");
    expect(user.canCreateSites).toBe(true);
  });

  it("elevates overlaid users to panel admin with create rights", async () => {
    await setPanelAdmin("builder", true);
    const user = await decorateUser({
      id: "3",
      username: "builder",
      role: "user",
      canCreateSites: false,
    });
    expect(user.panelRole).toBe("admin");
    expect(user.canCreateSites).toBe(true);
  });

  it("keeps plain users restricted", async () => {
    const user = await decorateUser({
      id: "4",
      username: "viewer",
      role: "user",
      canCreateSites: false,
    });
    expect(user.panelRole).toBe("user");
    expect(user.canCreateSites).toBe(false);
  });
});
