import { runDatabaseGatewayReconcile } from "@/server/cloudpanel/live-client";
import { sendNotification } from "@/server/notifications/send";

const INTERVAL_MS = 5 * 60_000;
type State = { timer?: NodeJS.Timeout; running: boolean; lastAlert?: number };
const globals = globalThis as typeof globalThis & {
  __panelDatabaseGatewayScheduler?: State;
};
const state = (globals.__panelDatabaseGatewayScheduler ??= { running: false });

export async function runDatabaseGatewayScheduler() {
  if (state.running) return;
  state.running = true;
  try {
    const result = await runDatabaseGatewayReconcile();
    if (
      (!result.ready || result.degraded > 0) &&
      (!state.lastAlert || Date.now() - state.lastAlert > 6 * 60 * 60_000)
    ) {
      state.lastAlert = Date.now();
      await sendNotification({
        title: "Database gateway needs attention",
        message: `${result.degraded} endpoint${result.degraded === 1 ? " is" : "s are"} fail-closed because gateway reconciliation did not complete.`,
        severity: "critical",
        event: "database-gateway.degraded",
      });
    }
  } finally {
    state.running = false;
  }
}

export function ensureDatabaseGatewayScheduler() {
  if (state.timer) return;
  state.timer = setInterval(
    () => void runDatabaseGatewayScheduler().catch(() => undefined),
    INTERVAL_MS,
  );
  state.timer.unref?.();
  void runDatabaseGatewayScheduler().catch(() => undefined);
}
