import { expect, it, vi } from "vitest";
import { getResourceHistory } from "@/server/system/resource-history";
import { fleetHealthPressured, getFleetHealthReport } from "./health";
import { executeFleetAction } from "./actions";
import { getCloudPanelClient } from "@/server/cloudpanel";
import type { PanelActor } from "@/server/auth/site-access";
vi.mock("@/server/system/resource-history", () => ({
  getResourceHistory: vi.fn(),
}));
vi.mock("@/server/cloudpanel", () => ({
  getCloudPanelClient: vi.fn(() => {
    throw new Error("Inventory must not run");
  }),
}));
const actor = {
  user: { panelRole: "super-admin" },
  cloudPanel: {},
} as PanelActor;

it("uses only the shared sample for an authorized lightweight request", async () => {
  const point = { t: Date.now(), cpu: 20, mem: 91, disk: 30 };
  vi.mocked(getResourceHistory).mockResolvedValue([point]);
  const result = await executeFleetAction(actor, "system.summary", {
    healthOnly: true,
  });
  expect(result).toEqual({ healthOnly: true, resourceSample: point });
  expect(getCloudPanelClient).not.toHaveBeenCalled();
  expect(fleetHealthPressured(result)).toBe(true);
  expect(JSON.stringify(result).length).toBeLessThan(160);
});
it("omits missing or stale resource samples without inventing fresh metrics", async () => {
  vi.mocked(getResourceHistory).mockResolvedValue([]);
  expect(await getFleetHealthReport()).toEqual({
    healthOnly: true,
    resourceSample: null,
  });
  vi.mocked(getResourceHistory).mockResolvedValue([
    { t: Date.now() - 180_000, cpu: 99, mem: 99, disk: 99 },
  ]);
  expect(fleetHealthPressured(await getFleetHealthReport())).toBe(false);
});
it("supports older full-summary peers and rejects malformed metrics", () => {
  expect(
    fleetHealthPressured({
      resources: {
        cpu: { usedPercent: 90 },
        memory: { usedPercent: 20 },
        disk: { usedPercent: 30 },
      },
    }),
  ).toBe(true);
  expect(() => fleetHealthPressured({ resources: {} })).toThrow();
});
it("keeps lightweight checks behind the existing Super Admin boundary", async () => {
  await expect(
    executeFleetAction(
      { ...actor, user: { ...actor.user, panelRole: "user" } },
      "system.summary",
      { healthOnly: true },
    ),
  ).rejects.toThrow(/Super Admin/);
});
