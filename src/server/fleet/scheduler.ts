import {
  refreshFleetNodesInBackground,
  resumeFleetRollingUpdates,
} from "@/server/fleet/service";

const INTERVAL_MS = 60_000;
const scheduler = globalThis as typeof globalThis & {
  __panelavoFleetScheduler?: ReturnType<typeof setInterval>;
};

export function ensureFleetScheduler() {
  if (scheduler.__panelavoFleetScheduler) return;
  void refreshFleetNodesInBackground().catch(() => undefined);
  void resumeFleetRollingUpdates().catch(() => undefined);
  scheduler.__panelavoFleetScheduler = setInterval(() => {
    void refreshFleetNodesInBackground().catch(() => undefined);
  }, INTERVAL_MS);
  scheduler.__panelavoFleetScheduler.unref?.();
}
