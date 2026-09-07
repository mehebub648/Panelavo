// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UpdateMaintenanceGuard } from "./update-maintenance-guard";
const fetcher = vi.fn();
const reply = (running: boolean) => ({
  ok: true,
  json: async () => ({ success: true, data: { running } }),
});
async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function hidden(value: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, value });
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  fetcher.mockReset().mockResolvedValue(reply(false));
  vi.stubGlobal("fetch", fetcher);
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("polls once per idle minute, pauses hidden tabs and refreshes on return", async () => {
  render(<UpdateMaintenanceGuard initialRunning={false} />);
  await tick();
  await tick(59_999);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await tick(1);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await hidden(true);
  await tick(180_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await hidden(false);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("accelerates during updates and stays locked on transient failures", async () => {
  fetcher.mockResolvedValue(reply(true));
  render(<UpdateMaintenanceGuard initialRunning={false} />);
  await tick();
  expect(screen.queryByText("Panelavo is updating")).not.toBeNull();
  fetcher.mockRejectedValueOnce(new Error("reloading"));
  await tick(2_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("Panelavo is updating")).not.toBeNull();
  await tick(2_000);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("never overlaps slow requests and aborts them when unmounted", async () => {
  fetcher.mockReturnValue(new Promise(() => {}));
  const view = render(<UpdateMaintenanceGuard initialRunning />);
  await tick(180_000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
  await tick(60_000);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("does not start a request while initially hidden", async () => {
  await hidden(true);
  render(<UpdateMaintenanceGuard initialRunning={false} />);
  await tick(60_000);
  expect(fetcher).not.toHaveBeenCalled();
  await hidden(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
