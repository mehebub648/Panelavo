import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimDueBackupSchedules,
  getBackupSchedule,
  saveBackupSchedule,
  scheduledSlot,
} from "./schedule";

describe("backup schedules", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "panelavo-backup-schedule-"));
    process.env.PANEL_DATA_DIR = directory;
  });

  afterEach(async () => {
    delete process.env.PANEL_DATA_DIR;
    await rm(directory, { recursive: true, force: true });
  });

  it("matches daily and weekly UTC slots", () => {
    const monday = new Date("2026-08-03T02:15:00.000Z");
    expect(
      scheduledSlot(
        { enabled: true, frequency: "daily", hour: 2, retention: 7 },
        monday,
      ),
    ).toBe("2026-08-03");
    expect(
      scheduledSlot(
        {
          enabled: true,
          frequency: "weekly",
          hour: 2,
          weekday: 1,
          retention: 7,
        },
        monday,
      ),
    ).toBe("2026-08-03-w1");
  });

  it("claims a due slot once and persists the outcome state", async () => {
    await saveBackupSchedule("Example.com", {
      enabled: true,
      frequency: "daily",
      hour: 2,
      retention: 5,
    });
    const now = new Date("2026-08-03T02:15:00.000Z");
    expect(await claimDueBackupSchedules(now)).toHaveLength(1);
    expect(await claimDueBackupSchedules(now)).toHaveLength(0);
    expect((await getBackupSchedule("example.com")).lastScheduledFor).toBe(
      "2026-08-03",
    );
    expect(
      JSON.parse(await readFile(join(directory, "backup-schedules.json"), "utf8")),
    ).toMatchObject({ sites: { "example.com": { retention: 5 } } });
  });
});
