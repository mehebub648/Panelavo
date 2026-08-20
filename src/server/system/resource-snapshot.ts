import type { CloudPanelSession, ServerResources } from "@/types/cloudpanel";
import { getCloudPanelClient } from "@/server/cloudpanel";

const CACHE_MS = 10_000;

type SnapshotState = {
  value?: ServerResources;
  expiresAt: number;
  pending?: Promise<ServerResources>;
};

const globalState = globalThis as typeof globalThis & {
  __panelResourceSnapshot?: SnapshotState;
};

const state = (globalState.__panelResourceSnapshot ??= { expiresAt: 0 });

export async function getServerResourceSnapshot(session: CloudPanelSession) {
  if (state.value && state.expiresAt > Date.now()) return state.value;
  if (state.pending) return state.pending;

  state.pending = getCloudPanelClient()
    .getServerResources(session)
    .then((value) => {
      state.value = value;
      state.expiresAt = Date.now() + CACHE_MS;
      return value;
    })
    .finally(() => {
      state.pending = undefined;
    });
  return state.pending;
}
