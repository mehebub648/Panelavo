import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  claimDueUptime,
  getUpdateMonitorState,
  updateUptimeState,
} from "./store";
import { sendNotification } from "@/server/notifications/send";
import { probeSite, runMonitoringScheduler } from "./scheduler";

vi.mock("./store", () => ({
  claimDueUptime: vi.fn(),
  getUpdateMonitorState: vi.fn(),
  saveUpdateMonitorState: vi.fn(),
  updateSslState: vi.fn(),
  updateUptimeState: vi.fn(),
}));
vi.mock("@/server/notifications/send", () => ({ sendNotification: vi.fn() }));
vi.mock("@/server/system/resource-history", () => ({
  ensureResourceSampler: vi.fn(),
}));
vi.mock("@/server/updates/panel-updater", () => ({ getUpdateState: vi.fn() }));
vi.mock("@/server/cloudpanel/live-client", () => ({
  getHostMaintenanceStatus: vi
    .fn()
    .mockResolvedValue({
      rebootRequired: false,
      securityUpdates: 0,
      unattendedUpgrades: true,
    }),
}));
const fetcher = vi.fn();
const cancel = vi.fn().mockResolvedValue(undefined);
const response = (status = 200) => ({ status, body: { cancel } });
function sites(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    domain: `site${i}.example.com`,
    config: { enabled: true, intervalMinutes: 5 },
    settings: { sslEnabled: false, uptimeFailureSamples: 3 },
  })) as Awaited<ReturnType<typeof claimDueUptime>>;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset().mockResolvedValue(response());
  vi.mocked(claimDueUptime).mockResolvedValue(sites(1));
  vi.mocked(getUpdateMonitorState).mockResolvedValue({
    settings: { updatesEnabled: false },
    state: {},
  } as Awaited<ReturnType<typeof getUpdateMonitorState>>);
  vi.mocked(updateUptimeState).mockImplementation(async (_, fn) =>
    fn({ status: "unknown", failures: 0, alerted: false }, {} as never),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("limits concurrency to four and progresses past a slow first website", async () => {
  vi.mocked(claimDueUptime).mockResolvedValue(sites(7));
  const pending: Array<() => void> = [];
  let active = 0;
  let peak = 0;
  fetcher.mockImplementation(
    () =>
      new Promise((resolve) => {
        peak = Math.max(peak, ++active);
        pending.push(() => {
          active--;
          resolve(response());
        });
      }),
  );
  const run = runMonitoringScheduler();
  await vi.waitFor(() => expect(pending).toHaveLength(4));
  await runMonitoringScheduler(); // Existing whole-sweep guard still applies.
  expect(pending).toHaveLength(4);
  pending[1]();
  await vi.waitFor(() => expect(pending).toHaveLength(5));
  pending[2]();
  pending[3]();
  await vi.waitFor(() => expect(pending).toHaveLength(7));
  pending[0]();
  pending[4]();
  pending[5]();
  pending[6]();
  await run;
  expect(peak).toBe(4);
  expect(updateUptimeState).toHaveBeenCalledTimes(7);
  expect(cancel).toHaveBeenCalledTimes(7);
});

it("continues the batch after one site's persistence failure", async () => {
  vi.mocked(claimDueUptime).mockResolvedValue(sites(6));
  vi.mocked(updateUptimeState).mockRejectedValueOnce(new Error("site failure"));
  await runMonitoringScheduler();
  expect(fetcher).toHaveBeenCalledTimes(6);
  expect(updateUptimeState).toHaveBeenCalledTimes(6);
});

it("preserves failure thresholds and recovery notifications", async () => {
  vi.mocked(claimDueUptime).mockResolvedValue(sites(2));
  fetcher
    .mockResolvedValueOnce(response(503))
    .mockResolvedValueOnce(response(200));
  vi.mocked(updateUptimeState).mockImplementation(async (domain, fn) =>
    fn(
      domain.startsWith("site0")
        ? { status: "unknown", failures: 2, alerted: false }
        : { status: "down", failures: 3, alerted: true },
      {} as never,
    ),
  );
  await runMonitoringScheduler();
  expect(sendNotification).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "uptime.down",
      site: "site0.example.com",
    }),
  );
  expect(sendNotification).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "uptime.recovery",
      site: "site1.example.com",
    }),
  );
});

it("bounds a probe and treats an unreachable website as down", async () => {
  fetcher.mockRejectedValueOnce(new Error("timed out"));
  expect(await probeSite("site.example.com")).toEqual({
    up: false,
    message: "timed out",
  });
  expect(fetcher).toHaveBeenCalledWith(
    "https://site.example.com/",
    expect.objectContaining({
      redirect: "manual",
      signal: expect.any(AbortSignal),
    }),
  );
});
