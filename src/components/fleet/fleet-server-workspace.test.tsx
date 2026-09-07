// @vitest-environment jsdom
import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetServerWorkspace } from "./fleet-server-workspace";
import type { CloudPanelUser } from "@/types/cloudpanel";
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/settings/update-manager", () => ({
  UpdateManager: () => null,
}));
vi.mock("@/components/settings/notification-manager", () => ({
  NotificationManager: () => null,
}));
vi.mock("@/components/settings/monitoring-manager", () => ({
  MonitoringManager: () => null,
}));
vi.mock("@/components/settings/security-policy-manager", () => ({
  SecurityPolicyManager: () => null,
}));
vi.mock("@/components/settings/connected-servers", () => ({
  ConnectedServers: () => null,
}));
vi.mock("@/components/settings/panel-address", () => ({
  PanelAddress: () => null,
}));
vi.mock("@/components/server/resources-view", () => ({
  ResourcesView: () => null,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("focused remote page loading", () => {
  it.each([
    ["settings", "panel.settings.get"],
    ["information", "system.info"],
    ["resources", "system.resources"],
    ["updates", "system.update.get"],
  ] as const)("%s loads only its own data", async (tab, action) => {
    const fetcher = vi.fn().mockResolvedValue({
      json: async () => ({
        success: true,
        data: { resources: {}, server: {} },
      }),
    });
    vi.stubGlobal("fetch", fetcher);
    render(
      <FleetServerWorkspace
        serverId="node"
        label="Node"
        user={{ panelRole: "super-admin" } as CloudPanelUser}
        tab={tab}
      />,
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(JSON.parse(fetcher.mock.calls[0][1].body).action).toBe(action);
  });

});
