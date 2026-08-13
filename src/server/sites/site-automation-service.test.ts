import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelActor } from "@/server/auth/site-access";

const mocks = vi.hoisted(() => ({
  accessibleSiteForActor: vi.fn(),
  writableSiteForActor: vi.fn(),
  getUptime: vi.fn(),
  saveUptime: vi.fn(),
  parseUptime: vi.fn(),
  getDeployHooks: vi.fn(),
  setDeployHooks: vi.fn(),
  parseDeployHooks: vi.fn(),
  getBackupSchedule: vi.fn(),
  saveBackupSchedule: vi.fn(),
  parseBackupSchedule: vi.fn(),
  getOffsiteDestination: vi.fn(),
  saveOffsiteDestination: vi.fn(),
  removeOffsiteDestination: vi.fn(),
  listOffsiteBackups: vi.fn(),
  uploadOffsiteBackup: vi.fn(),
  restoreOffsiteBackup: vi.fn(),
  deleteOffsiteBackup: vi.fn(),
  parseOffsiteDestination: vi.fn(),
  manageSiteSectionForActor: vi.fn(),
}));

vi.mock("@/server/auth/site-access", () => ({
  accessibleSiteForActor: mocks.accessibleSiteForActor,
  writableSiteForActor: mocks.writableSiteForActor,
}));
vi.mock("@/server/monitoring/store", () => ({
  getUptime: mocks.getUptime,
  saveUptime: mocks.saveUptime,
  uptimeConfigSchema: { parse: mocks.parseUptime },
}));
vi.mock("@/server/deploy/hooks", () => ({
  getDeployHooks: mocks.getDeployHooks,
  setDeployHooks: mocks.setDeployHooks,
  deployHooksSchema: { parse: mocks.parseDeployHooks },
}));
vi.mock("@/server/backups/schedule", () => ({
  getBackupSchedule: mocks.getBackupSchedule,
  saveBackupSchedule: mocks.saveBackupSchedule,
  backupScheduleSchema: { parse: mocks.parseBackupSchedule },
}));
vi.mock("@/server/backups/offsite", () => ({
  getOffsiteDestination: mocks.getOffsiteDestination,
  saveOffsiteDestination: mocks.saveOffsiteDestination,
  removeOffsiteDestination: mocks.removeOffsiteDestination,
  listOffsiteBackups: mocks.listOffsiteBackups,
  uploadOffsiteBackup: mocks.uploadOffsiteBackup,
  restoreOffsiteBackup: mocks.restoreOffsiteBackup,
  deleteOffsiteBackup: mocks.deleteOffsiteBackup,
  offsiteDestinationSchema: { parse: mocks.parseOffsiteDestination },
}));
vi.mock("@/server/sites/site-section-service", () => ({
  manageSiteSectionForActor: mocks.manageSiteSectionForActor,
}));

import {
  getSiteBackupAutomationForActor,
  getSiteDeployHooksForActor,
  getSiteUptimeForActor,
  manageSiteOffsiteBackupForActor,
  removeSiteOffsiteDestinationForActor,
  saveSiteBackupScheduleForActor,
  saveSiteDeployHooksForActor,
  saveSiteOffsiteDestinationForActor,
  saveSiteUptimeForActor,
} from "./site-automation-service";

const actor: PanelActor = {
  user: {
    id: "user-1",
    username: "alice",
    canCreateSites: true,
    panelRole: "admin",
  },
  cloudPanel: { cookies: {}, usernameHint: "alice" },
  authentication: "mcp",
  credentialId: "connection-1",
};
const domain = "site.example.test";

describe("actor-aware site automation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accessibleSiteForActor.mockResolvedValue({});
    mocks.writableSiteForActor.mockResolvedValue({});
    mocks.parseUptime.mockImplementation((input) => input);
    mocks.parseDeployHooks.mockImplementation((input) => input);
    mocks.parseBackupSchedule.mockImplementation((input) => input);
    mocks.parseOffsiteDestination.mockImplementation((input) => input);
    mocks.listOffsiteBackups.mockResolvedValue([]);
  });

  it("uses readable access for uptime reads and stops before delegation when denied", async () => {
    const uptime = {
      config: { enabled: true, intervalMinutes: 5 },
      state: { status: "up" },
    };
    mocks.getUptime.mockResolvedValueOnce(uptime);

    await expect(getSiteUptimeForActor(actor, domain)).resolves.toBe(uptime);
    expect(mocks.accessibleSiteForActor).toHaveBeenCalledWith(actor, domain);
    expect(mocks.writableSiteForActor).not.toHaveBeenCalled();
    expect(mocks.getUptime).toHaveBeenCalledWith(domain);

    vi.clearAllMocks();
    const denied = new Error("denied");
    mocks.accessibleSiteForActor.mockRejectedValueOnce(denied);
    await expect(getSiteUptimeForActor(actor, domain)).rejects.toBe(denied);
    expect(mocks.getUptime).not.toHaveBeenCalled();
  });

  it("requires write access before validating and saving uptime settings", async () => {
    const input = { enabled: true, intervalMinutes: 10 };
    const parsed = { enabled: true, intervalMinutes: 15 };
    const saved = { config: parsed, state: { status: "unknown" } };
    mocks.parseUptime.mockReturnValueOnce(parsed);
    mocks.saveUptime.mockResolvedValueOnce(saved);

    await expect(saveSiteUptimeForActor(actor, domain, input)).resolves.toBe(
      saved,
    );
    expect(mocks.writableSiteForActor).toHaveBeenCalledWith(actor, domain);
    expect(mocks.parseUptime).toHaveBeenCalledWith(input);
    expect(mocks.saveUptime).toHaveBeenCalledWith(domain, parsed);
    expect(mocks.writableSiteForActor.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.parseUptime.mock.invocationCallOrder[0],
    );

    vi.clearAllMocks();
    const denied = new Error("denied");
    mocks.writableSiteForActor.mockRejectedValueOnce(denied);
    await expect(saveSiteUptimeForActor(actor, domain, input)).rejects.toBe(
      denied,
    );
    expect(mocks.parseUptime).not.toHaveBeenCalled();
    expect(mocks.saveUptime).not.toHaveBeenCalled();
  });

  it("requires write access and delegates deployment hook reads and writes", async () => {
    const input = [{ command: "pnpm-install" }];
    const parsed = [{ command: "composer-install" }];
    mocks.getDeployHooks.mockResolvedValueOnce(input);
    mocks.parseDeployHooks.mockReturnValueOnce(parsed);
    mocks.setDeployHooks.mockResolvedValueOnce(parsed);

    await expect(getSiteDeployHooksForActor(actor, domain)).resolves.toBe(
      input,
    );
    await expect(
      saveSiteDeployHooksForActor(actor, domain, input),
    ).resolves.toBe(parsed);
    expect(mocks.writableSiteForActor).toHaveBeenNthCalledWith(
      1,
      actor,
      domain,
    );
    expect(mocks.writableSiteForActor).toHaveBeenNthCalledWith(
      2,
      actor,
      domain,
    );
    expect(mocks.getDeployHooks).toHaveBeenCalledWith(domain);
    expect(mocks.parseDeployHooks).toHaveBeenCalledWith(input);
    expect(mocks.setDeployHooks).toHaveBeenCalledWith(domain, parsed);
  });

  it("loads backup schedule, destination, and remote inventory after write access", async () => {
    const schedule = { enabled: true };
    const destination = { enabled: true, bucket: "backups" };
    const offsiteBackups = [{ id: "backup-1" }];
    mocks.getBackupSchedule.mockResolvedValueOnce(schedule);
    mocks.getOffsiteDestination.mockResolvedValueOnce(destination);
    mocks.listOffsiteBackups.mockResolvedValueOnce(offsiteBackups);

    await expect(
      getSiteBackupAutomationForActor(actor, domain),
    ).resolves.toEqual({ schedule, destination, offsiteBackups });
    expect(mocks.writableSiteForActor).toHaveBeenCalledWith(actor, domain);
    expect(mocks.getBackupSchedule).toHaveBeenCalledWith(domain);
    expect(mocks.getOffsiteDestination).toHaveBeenCalledWith(domain);
    expect(mocks.listOffsiteBackups).toHaveBeenCalledWith(domain);
  });

  it("keeps backup automation available when remote inventory listing fails", async () => {
    const schedule = { enabled: false };
    const destination = null;
    mocks.getBackupSchedule.mockResolvedValueOnce(schedule);
    mocks.getOffsiteDestination.mockResolvedValueOnce(destination);
    mocks.listOffsiteBackups.mockRejectedValueOnce(new Error("remote down"));

    await expect(
      getSiteBackupAutomationForActor(actor, domain),
    ).resolves.toEqual({ schedule, destination, offsiteBackups: [] });
  });

  it("validates and delegates backup schedule and off-site destination updates", async () => {
    const scheduleInput = { enabled: true, frequency: "daily", hour: 2 };
    const parsedSchedule = { ...scheduleInput, retention: 10 };
    const destinationInput = { endpoint: "https://s3.example.test" };
    const parsedDestination = { ...destinationInput, bucket: "backups" };
    const destination = { enabled: true, bucket: "backups" };
    const offsiteBackups = [{ id: "backup-1" }];
    mocks.parseBackupSchedule.mockReturnValueOnce(parsedSchedule);
    mocks.saveBackupSchedule.mockResolvedValueOnce(parsedSchedule);
    mocks.parseOffsiteDestination.mockReturnValueOnce(parsedDestination);
    mocks.saveOffsiteDestination.mockResolvedValueOnce(destination);
    mocks.listOffsiteBackups.mockResolvedValueOnce(offsiteBackups);

    await expect(
      saveSiteBackupScheduleForActor(actor, domain, scheduleInput),
    ).resolves.toBe(parsedSchedule);
    await expect(
      saveSiteOffsiteDestinationForActor(actor, domain, destinationInput),
    ).resolves.toEqual({ destination, offsiteBackups });
    expect(mocks.parseBackupSchedule).toHaveBeenCalledWith(scheduleInput);
    expect(mocks.saveBackupSchedule).toHaveBeenCalledWith(
      domain,
      parsedSchedule,
    );
    expect(mocks.parseOffsiteDestination).toHaveBeenCalledWith(
      destinationInput,
    );
    expect(mocks.saveOffsiteDestination).toHaveBeenCalledWith(
      domain,
      parsedDestination,
    );
    expect(mocks.listOffsiteBackups).toHaveBeenCalledWith(domain);
  });

  it("delegates off-site removal and upload/delete actions only after write access", async () => {
    await expect(
      removeSiteOffsiteDestinationForActor(actor, domain),
    ).resolves.toEqual({ deleted: true });
    expect(mocks.removeOffsiteDestination).toHaveBeenCalledWith(domain);

    for (const [action, operation] of [
      ["upload", mocks.uploadOffsiteBackup],
      ["delete", mocks.deleteOffsiteBackup],
    ] as const) {
      vi.clearAllMocks();
      mocks.writableSiteForActor.mockResolvedValue({});
      mocks.listOffsiteBackups.mockResolvedValue([]);
      await expect(
        manageSiteOffsiteBackupForActor(actor, domain, action, "backup-1"),
      ).resolves.toEqual({ offsiteBackups: [] });
      expect(mocks.writableSiteForActor).toHaveBeenCalledWith(actor, domain);
      expect(operation).toHaveBeenCalledWith(domain, "backup-1");
      expect(mocks.listOffsiteBackups).toHaveBeenCalledWith(domain);
      expect(mocks.restoreOffsiteBackup).not.toHaveBeenCalled();
      expect(mocks.manageSiteSectionForActor).not.toHaveBeenCalled();
    }
  });

  it("restores the remote bundle before delegating the local all-scope restore", async () => {
    const offsiteBackups = [{ id: "backup-1" }];
    mocks.listOffsiteBackups.mockResolvedValueOnce(offsiteBackups);

    await expect(
      manageSiteOffsiteBackupForActor(actor, domain, "restore", "backup-1"),
    ).resolves.toEqual({ offsiteBackups });
    expect(mocks.restoreOffsiteBackup).toHaveBeenCalledWith(domain, "backup-1");
    expect(mocks.manageSiteSectionForActor).toHaveBeenCalledWith(
      actor,
      domain,
      "backups",
      { action: "restore", id: "backup-1", scope: "all" },
    );
    expect(mocks.restoreOffsiteBackup.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.manageSiteSectionForActor.mock.invocationCallOrder[0],
    );
    expect(
      mocks.manageSiteSectionForActor.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.listOffsiteBackups.mock.invocationCallOrder[0]);
  });

  it("does not call any backup delegate when write access is denied", async () => {
    const denied = new Error("denied");
    mocks.writableSiteForActor.mockRejectedValueOnce(denied);

    await expect(getSiteBackupAutomationForActor(actor, domain)).rejects.toBe(
      denied,
    );
    expect(mocks.getBackupSchedule).not.toHaveBeenCalled();
    expect(mocks.getOffsiteDestination).not.toHaveBeenCalled();
    expect(mocks.listOffsiteBackups).not.toHaveBeenCalled();
  });

  it("blocks hook and backup mutations before their delegates when write access is denied", async () => {
    const denied = new Error("denied");
    const attempts: Array<[() => Promise<unknown>, ReturnType<typeof vi.fn>]> =
      [
        [() => getSiteDeployHooksForActor(actor, domain), mocks.getDeployHooks],
        [
          () =>
            saveSiteBackupScheduleForActor(actor, domain, {
              enabled: false,
            }),
          mocks.saveBackupSchedule,
        ],
        [
          () => saveSiteOffsiteDestinationForActor(actor, domain, {}),
          mocks.saveOffsiteDestination,
        ],
        [
          () => removeSiteOffsiteDestinationForActor(actor, domain),
          mocks.removeOffsiteDestination,
        ],
        [
          () =>
            manageSiteOffsiteBackupForActor(
              actor,
              domain,
              "upload",
              "backup-1",
            ),
          mocks.uploadOffsiteBackup,
        ],
      ];

    for (const [attempt, delegate] of attempts) {
      vi.clearAllMocks();
      mocks.writableSiteForActor.mockRejectedValueOnce(denied);
      await expect(attempt()).rejects.toBe(denied);
      expect(delegate).not.toHaveBeenCalled();
    }
  });
});
