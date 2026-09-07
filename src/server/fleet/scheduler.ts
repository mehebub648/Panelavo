import {
  refreshFleetNodesInBackground,
  resumeFleetRollingUpdates,
} from "@/server/fleet/service";

const INTERVAL_MS = 60_000;
const scheduler = globalThis as typeof globalThis & {
  __panelavoFleetScheduler?: ReturnType<typeof setInterval>;
  __panelavoFleetSweep?: Promise<unknown>;
};

function sweep() {
  if (scheduler.__panelavoFleetSweep) return;
  scheduler.__panelavoFleetSweep = Promise.resolve()
    .then(() => refreshFleetNodesInBackground())
    .catch(() => undefined)
    .finally(() => {
      scheduler.__panelavoFleetSweep = undefined;
    });
}

export function ensureFleetScheduler() {
  if (scheduler.__panelavoFleetScheduler) return;
  sweep();
  void resumeFleetRollingUpdates().catch(() => undefined);
  scheduler.__panelavoFleetScheduler = setInterval(() => {
    sweep();
  }, INTERVAL_MS);
  scheduler.__panelavoFleetScheduler.unref?.();
}
