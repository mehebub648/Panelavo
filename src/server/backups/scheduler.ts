import { runScheduledBackup } from "@/server/cloudpanel/live-client";
import { audit } from "@/server/security/log";
import { getSiteRootOverride } from "@/server/sites/site-root-overlay";
import {
  claimDueBackupSchedules,
  recordBackupScheduleOutcome,
} from "./schedule";

const INTERVAL_MS = 60_000;
type SchedulerState = { timer?: NodeJS.Timeout; running: boolean };
const globals = globalThis as typeof globalThis & {
  __panelBackupScheduler?: SchedulerState;
};
const state = (globals.__panelBackupScheduler ??= { running: false });

export async function runBackupScheduler(now = new Date()) {
  if (state.running) return;
  state.running = true;
  try {
    for (const { domain, schedule } of await claimDueBackupSchedules(now)) {
      try {
        const result = await runScheduledBackup({
          domain,
          applicationRootDirectory: await getSiteRootOverride(domain),
          retention: schedule.retention,
        });
        await recordBackupScheduleOutcome(domain, {
          lastOutcome: result.skipped ? "skipped" : "success",
          lastMessage: result.skipped
            ? "Skipped because another site operation held the lock."
            : undefined,
          lastBackupId: result.backupId,
        });
        void audit(
          "backups.scheduled",
          result.skipped ? "failure" : "success",
          { site: domain, reason: result.skipped ? "operation-busy" : undefined },
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "The scheduled backup failed.";
        await recordBackupScheduleOutcome(domain, {
          lastOutcome: "failed",
          lastMessage: message.slice(0, 300),
        });
        void audit("backups.scheduled", "failure", { site: domain });
      }
    }
  } finally {
    state.running = false;
  }
}

export function ensureBackupScheduler() {
  if (state.timer) return;
  state.timer = setInterval(() => void runBackupScheduler(), INTERVAL_MS);
  state.timer.unref?.();
  void runBackupScheduler();
}
