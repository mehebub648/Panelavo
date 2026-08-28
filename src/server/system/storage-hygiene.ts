import { statfs } from "node:fs/promises";
import { AppError } from "@/server/cloudpanel/errors";
import { runStorageHygiene } from "@/server/cloudpanel/live-client";
import { sendNotification } from "@/server/notifications/send";

const INTERVAL_MS = 15 * 60_000;
const MINIMUM_RESERVE = 2_000_000_000;
const MAXIMUM_RESERVE = 10_000_000_000;

type State = {
  timer?: NodeJS.Timeout;
  running: boolean;
  alerted: boolean;
  lastAlert?: number;
};

const globals = globalThis as typeof globalThis & {
  __panelStorageHygieneScheduler?: State;
};
const state = (globals.__panelStorageHygieneScheduler ??= {
  running: false,
  alerted: false,
});

export async function getDiskPressure() {
  const filesystem = await statfs("/");
  const totalBytes = filesystem.blocks * filesystem.bsize;
  const availableBytes = filesystem.bavail * filesystem.bsize;
  const usedBytes = Math.max(0, totalBytes - filesystem.bfree * filesystem.bsize);
  const usedPercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 100;
  const requiredAvailableBytes = Math.max(
    MINIMUM_RESERVE,
    Math.min(MAXIMUM_RESERVE, Math.floor(totalBytes * 0.1)),
  );
  return {
    totalBytes,
    availableBytes,
    requiredAvailableBytes,
    usedPercent,
    blocked: usedPercent >= 92 || availableBytes < requiredAvailableBytes,
  };
}

export async function assertDiskGrowthAllowed() {
  const pressure = await getDiskPressure();
  if (!pressure.blocked) return pressure;
  throw new AppError(
    "SITE_UPDATE_FAILED",
    `This operation is paused to protect the server from running out of storage. Free space must be at least ${(pressure.requiredAvailableBytes / 1_000_000_000).toFixed(1)} GB and disk usage must be below 92%.`,
    507,
  );
}

export async function runStorageHygieneScheduler() {
  if (state.running) return;
  state.running = true;
  try {
    const result = await runStorageHygiene();
    const now = Date.now();
    if (
      result.blocked &&
      (!state.lastAlert || now - state.lastAlert >= 6 * 60 * 60_000)
    ) {
      state.alerted = true;
      state.lastAlert = now;
      await sendNotification({
        title: "Server storage growth is paused",
        message:
          result.reason ||
          "Panelavo paused storage-growing actions because the server is close to its safe disk limit.",
        severity: "critical",
        event: "storage.pressure",
      });
    } else if (!result.blocked && state.alerted) {
      state.alerted = false;
      await sendNotification({
        title: "Server storage recovered",
        message: "Free space is back above Panelavo's production safety reserve.",
        severity: "recovery",
        event: "storage.recovery",
      });
    }
  } finally {
    state.running = false;
  }
}

export function ensureStorageHygieneScheduler() {
  if (state.timer) return;
  state.timer = setInterval(
    () => void runStorageHygieneScheduler().catch(() => undefined),
    INTERVAL_MS,
  );
  state.timer.unref?.();
  void runStorageHygieneScheduler().catch(() => undefined);
}
