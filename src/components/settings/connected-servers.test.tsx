// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedServers } from "./connected-servers";
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("simple connection settings", () => {
  it("loads and generates sharing tokens on the selected server", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({
        json: async () => ({
          success: true,
          data: {
            outgoing: [],
            incoming: [],
            token: "remote-token",
            expiresAt: new Date().toISOString(),
          },
        }),
      });
    vi.stubGlobal("fetch", fetcher);
    render(<ConnectedServers apiBase="/api/fleet/servers/remote/proxy" />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Generate token" }));
    await screen.findByLabelText("Connection token");
    expect(
      fetcher.mock.calls.every(
        ([url]) => url === "/api/fleet/servers/remote/proxy/api/connections",
      ),
    ).toBe(true);
  });
  it("generates a one-use token in one click without activation or password fields", async () => {
    const fetcher = vi.fn().mockImplementation(async (_url, options) => ({
      json: async () => ({
        success: true,
        data:
          options?.method === "POST"
            ? {
                token: "one-use-test-token",
                expiresAt: new Date(Date.now() + 600_000).toISOString(),
              }
            : { outgoing: [], incoming: [] },
      }),
    }));
    vi.stubGlobal("fetch", fetcher);
    render(<ConnectedServers />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Generate token" }));
    expect(await screen.findByLabelText("Connection token")).toHaveValue(
      "one-use-test-token",
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/api/connections",
      expect.objectContaining({
        body: JSON.stringify({ action: "generate-token" }),
      }),
    );
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });
  it("submits only the pasted token and clears it on success", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      json: async () => ({
        success: true,
        data: { outgoing: [], incoming: [] },
      }),
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ConnectedServers />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "I have a token" }));
    fireEvent.change(screen.getByLabelText("Paste connection token"), {
      target: { value: "test-invitation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect server" }));
    await waitFor(() =>
      expect(
        screen.queryByLabelText("Paste connection token"),
      ).not.toBeInTheDocument(),
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/api/connections",
      expect.objectContaining({
        body: JSON.stringify({
          action: "submit-token",
          token: "test-invitation",
        }),
      }),
    );
  });
});
