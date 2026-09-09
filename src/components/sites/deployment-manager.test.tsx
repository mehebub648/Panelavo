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
import { DeploymentManager } from "./deployment-manager";
import { DeployHookManager } from "./deploy-hook-manager";
import { LazySiteSection } from "./lazy-site-section";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
describe("deployment browser workflow", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  it("restores failed-step output after leaving and reopening the page", async () => {
    const job = {
      id: "job-1",
      kind: "Deploy latest changes",
      status: "failed",
      createdAt: "2026-09-09T00:00:00Z",
      finishedAt: "2026-09-09T00:01:00Z",
      result: {
        source: { status: "updated", commit: "a".repeat(40) },
        deployment: {
          exitCode: 1,
          steps: [
            {
              command: "node-run",
              label: "Build application",
              exitCode: 1,
              output: "Missing required build dependency",
            },
          ],
        },
      },
    };
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ success: true, data: { jobs: [job] } }),
    } as Response);
    const first = render(<DeploymentManager domain="site.test" canWrite />);
    expect(
      await screen.findByText("Missing required build dependency"),
    ).toBeVisible();
    expect(screen.getByText(/Source updated/)).toBeVisible();
    first.unmount();
    render(<DeploymentManager domain="site.test" canWrite />);
    expect(
      await screen.findByText("Missing required build dependency"),
    ).toBeVisible();
  });
  it("shows a retryable settings error without save or empty-recipe controls", async () => {
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({
        success: false,
        error: { message: "Settings unavailable" },
      }),
    } as Response);
    render(<DeployHookManager domain="site.test" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Settings unavailable",
    );
    expect(
      screen.queryByRole("button", { name: /Save/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });
  it("blocks deployment when history or server capability cannot be loaded", async () => {
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({
        success: false,
        error: {
          message: "Update this connected server to use deployment jobs.",
        },
      }),
    } as Response);
    render(<DeploymentManager domain="site.test" canWrite />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Update this connected server",
    );
    expect(
      screen.getByRole("button", { name: "Deploy latest changes" }),
    ).toBeDisabled();
  });
  it("provides status without write controls to read-only users", async () => {
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ success: true, data: { jobs: [] } }),
    } as Response);
    render(<DeploymentManager domain="site.test" canWrite={false} />);
    await screen.findByText("No successful deployment in recent history.");
    expect(
      screen.queryByRole("button", { name: /Deploy latest/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Deployment settings/)).not.toBeInTheDocument();
  });
  it("loads detailed logs only when opened", async () => {
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ success: true, data: { items: [] } }),
    } as Response);
    render(
      <LazySiteSection
        domain="site.test"
        section="logs"
        title="Application logs"
        canWrite
      />,
    );
    expect(fetch).not.toHaveBeenCalled();
    const details = screen.getByText("Application logs").closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith("/api/sites/site.test/sections/logs");
  });
  it("keeps keyboard focus in the deployment review and restores it on Escape", async () => {
    vi.mocked(fetch).mockResolvedValue({
      json: async () => ({ success: true, data: { jobs: [] } }),
    } as Response);
    render(<DeploymentManager domain="site.test" canWrite />);
    const deploy = screen.getByRole("button", {
      name: "Deploy latest changes",
    });
    await waitFor(() => expect(deploy).toBeEnabled());
    deploy.focus();
    fireEvent.click(deploy);
    const dialog = screen.getByRole("dialog", {
      name: "Deploy latest changes?",
    });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(
      within(dialog).getByRole("button", { name: "Deploy" }),
    ).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deploy).toHaveFocus();
  });
});
