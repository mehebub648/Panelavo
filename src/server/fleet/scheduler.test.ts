import { afterEach, expect, it, vi } from "vitest";
import {
  refreshFleetNodesInBackground,
  resumeFleetRollingUpdates,
} from "./service";
import { ensureFleetScheduler } from "./scheduler";
vi.mock("./service", () => ({
  refreshFleetNodesInBackground: vi.fn(),
  resumeFleetRollingUpdates: vi.fn().mockResolvedValue(undefined),
}));
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  const globals = globalThis as typeof globalThis & {
    __panelavoFleetScheduler?: unknown;
    __panelavoFleetSweep?: unknown;
  };
  delete globals.__panelavoFleetScheduler;
  delete globals.__panelavoFleetSweep;
  vi.clearAllMocks();
});
it("skips overlapping ticks, survives module reload, and resumes after failure", async () => {
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  vi.mocked(refreshFleetNodesInBackground)
    .mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValue([]);
  ensureFleetScheduler();
  ensureFleetScheduler();
  await vi.advanceTimersByTimeAsync(180_000);
  expect(refreshFleetNodesInBackground).toHaveBeenCalledTimes(1);
  expect(resumeFleetRollingUpdates).toHaveBeenCalledTimes(1);
  vi.resetModules();
  (await import("./scheduler")).ensureFleetScheduler();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(refreshFleetNodesInBackground).toHaveBeenCalledTimes(1);
  reject(new Error("offline"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(refreshFleetNodesInBackground).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(refreshFleetNodesInBackground).toHaveBeenCalledTimes(3);
});
