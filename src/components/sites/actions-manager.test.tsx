// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { normalizeOperationsData } from "@/server/sites/site-operations";
import type { OperationsData, RawOperationsData } from "@/types/operations";
import { ActionsManager } from "./actions-manager";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error },
}));

function dockerData(ready: boolean): OperationsData {
  const raw: RawOperationsData = {
    type: "reverse-proxy",
    path: "/home/site-24001/htdocs/example.test",
    checkedAt: "2026-07-12T00:00:00.000Z",
    hasCompose: true,
    framework: "Docker Compose",
    permissions: { manage: true, docker: true },
    tools: {
      docker: {
        id: "docker",
        label: "Docker",
        available: ready,
        version: ready ? "28.3.0" : undefined,
      },
    },
    compose: {
      file: "compose.yaml",
      cliAvailable: ready,
      pluginAvailable: ready,
      daemonAvailable: ready,
      rootless: {
        mode: "rootless",
        ready,
        uidmapAvailable: ready,
        rootlessExtrasAvailable: ready,
        buildxAvailable: ready,
        buildxHostReady: ready,
        hostRootlessReady: ready,
        networkHelperAvailable: ready,
        subuidReady: ready,
        subgidReady: ready,
        lingerEnabled: ready,
        runtimeDirectoryReady: ready,
        userBusReady: ready,
        socketReady: ready,
        daemonAvailable: ready,
        securityRootless: ready,
        storageReady: ready,
        cgroupReady: ready,
        storageDriver: ready ? "overlay2" : undefined,
      },
      configValid: ready,
      safe: ready,
      services: ready ? ["web", "database"] : [],
      expectedPort: 24001,
      entryService: ready ? "web" : undefined,
      containerPort: ready ? 3000 : undefined,
      publishedPort: ready ? 24001 : undefined,
      portMatches: ready,
      canAutoRemap: false,
      portDetail: ready
        ? 'Entry service "web" maps container port 3000 to 127.0.0.1:24001, matching the configured upstream.'
        : undefined,
    },
  };
  return normalizeOperationsData(raw, { typeOverride: "docker", panelAdmin: true });
}

describe("ActionsManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(callback, 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) =>
      window.clearTimeout(id),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { jobs: [] } }) }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows a Docker blocker and never enables deploy when only a Compose file was detected", () => {
    render(
      <ActionsManager domain="example.test" initialData={dockerData(false)} />,
    );

    expect(screen.getByText("Docker Compose")).toBeInTheDocument();
    expect(
      screen.getAllByText(
        "The Docker executable is not installed on this server.",
      ),
    ).not.toHaveLength(0);
    expect(screen.getByRole("button", { name: "Deploy current files" })).toBeDisabled();
    screen.getByText("Advanced: Runtime & lifecycle").closest("details")!.open = true;
    expect(
      screen.getByRole("button", { name: /^Start services/i }),
    ).toBeDisabled();
    expect(
      screen.queryByText("No managed actions for this architecture"),
    ).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([, request]) => request?.method === "POST")).toBe(false);
  });

  it("submits a persistent deployment job after reviewing current-file deployment", async () => {
    vi.mocked(fetch).mockImplementation(async (_url, request) => ({ ok: true, json: async () => request?.method === "POST" ? { success: true, data: { id: "job-1", kind: "Deploy current files", status: "queued", createdAt: new Date().toISOString(), logs: [] } } : { success: true, data: { jobs: [] } } }) as Response);
    render(<ActionsManager domain="example.test" initialData={dockerData(true)} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Deploy current files" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Deploy current files" }));
    const dialog = screen.getByRole("dialog", { name: "Deploy current files?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Deploy" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([, request]) => request?.method === "POST")).toBe(true));
    const [url, request] = vi.mocked(fetch).mock.calls.find(([, request]) => request?.method === "POST")!;
    expect(url).toBe("/api/sites/example.test/deployments");
    expect(JSON.parse(String(request?.body))).toEqual({ source: "current" });
    expect((request?.headers as Record<string, string>)["idempotency-key"]).toBeTruthy();
    expect(await screen.findByText(/Deploy current files: queued/)).toBeInTheDocument();
  });

  it("requires confirmation before a destructive Compose action", async () => {
    render(
      <ActionsManager domain="example.test" initialData={dockerData(true)} />,
    );

    screen.getByText("Advanced: Runtime & lifecycle").closest("details")!.open = true;
    fireEvent.click(screen.getByRole("button", { name: /Stop project/i }));
    const dialog = await screen.findByRole("dialog", {
      name: "Stop the entire Compose project?",
    });
    expect(vi.mocked(fetch).mock.calls.some(([, request]) => request?.method === "POST")).toBe(false);
    expect(
      within(dialog).getByText(/Named volumes are preserved/i),
    ).toBeInTheDocument();
  });

  it("collects missing Compose values without repeating raw logs on actions", async () => {
    const raw: RawOperationsData = {
      type: "reverse-proxy",
      path: "/home/site/htdocs/example.test",
      permissions: { manage: true, docker: true },
      hasCompose: true,
      compose: {
        file: "compose.yaml",
        cliAvailable: true,
        pluginAvailable: true,
        daemonAvailable: true,
        configValid: false,
        detail:
          'level=warning msg="The \\"HOST_DATA_DIR\\" variable is not set. Defaulting to a blank string."',
      },
    };
    const initialData = normalizeOperationsData(raw, { typeOverride: "docker" });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { jobs: [] } }),
    } as Response);

    render(<ActionsManager domain="example.test" initialData={initialData} />);

    expect(screen.queryByText(/level=warning/)).not.toBeInTheDocument();
    expect(
      screen.queryByText("Resolve the Compose validation check above."),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add missing values" }));
    const dialog = screen.getByRole("dialog", {
      name: "Add missing environment values",
    });
    fireEvent.change(within(dialog).getByLabelText("HOST_DATA_DIR"), {
      target: { value: "/home/site/data" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save and recheck" }));

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([, request]) => request?.method === "POST")).toBe(true));
    const [, request] = vi.mocked(fetch).mock.calls.find(([, request]) => request?.method === "POST")!;
    expect(JSON.parse(String(request?.body))).toEqual({
      action: "upsert",
      entries: [{ key: "HOST_DATA_DIR", value: "/home/site/data" }],
    });
    expect(mocks.refresh).toHaveBeenCalled();
  });
});
