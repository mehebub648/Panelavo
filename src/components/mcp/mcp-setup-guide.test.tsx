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
import type { CloudPanelUser, PanelRole } from "@/types/cloudpanel";
import { McpSetupGuide, mcpAccessSummary } from "./mcp-setup-guide";

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("sonner", () => ({
  toast: toastMocks,
}));

vi.mock("@/components/ui/copy-value", () => ({
  CopyValue: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function user(panelRole: PanelRole): CloudPanelUser {
  return {
    id: "1",
    username: "demo",
    panelRole,
    canCreateSites: panelRole !== "user",
  };
}

describe("AI access guide", () => {
  it("explains each user's effective Panelavo access", () => {
    expect(mcpAccessSummary("super-admin").title).toBe(
      "All websites and repairs",
    );
    expect(mcpAccessSummary("manager").title).toBe("All websites");
    expect(mcpAccessSummary("admin").title).toBe("Your websites");
    expect(mcpAccessSummary("user").detail).toContain("view-only");
  });

  it("offers the portable plugin without exposing MCP or token setup", () => {
    render(
      <McpSetupGuide
        user={user("admin")}
        initialConnections={[]}
        pluginDownloadUrl="/download/panelavo-plugin.zip"
      />,
    );

    expect(screen.getByText("Add Panelavo to ChatGPT")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download Panelavo plugin" }),
    ).toBeEnabled();
    expect(screen.getByText(/server independently/)).toBeInTheDocument();
    expect(screen.getByText(/site 20004/)).toHaveTextContent(
      "site 20004 starts on port 20004",
    );
    expect(screen.getByText(/Existing sites keep/)).toBeInTheDocument();
    expect(screen.queryByText(/MCP endpoint/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Generate token/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Bearer token/i)).not.toBeInTheDocument();
  });

  it("reports the hosted service prerequisite instead of saving a broken ZIP", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({
          error: {
            message:
              "A server administrator must set PANELAVO_PLUGIN_ENABLED=1 and reload Panelavo.",
          },
        }),
      }),
    );
    render(
      <McpSetupGuide
        user={user("admin")}
        initialConnections={[]}
        pluginDownloadUrl="/download/panelavo-plugin.zip"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Download Panelavo plugin" }),
    );

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        expect.stringContaining("PANELAVO_PLUGIN_ENABLED=1"),
      ),
    );
  });

  it("keeps an existing compatible grant visible and revocable", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ success: true, data: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <McpSetupGuide
        user={user("admin")}
        initialConnections={[
          {
            id: "3b0c4b0f-e4de-49ba-8aa7-b146675cd752",
            clientId: "existing-client",
            clientName: "Existing Codex",
            kind: "personal-token",
            createdAt: Date.now(),
            expiresAt: Date.now() + 86_400_000,
          },
        ]}
      />,
    );

    expect(screen.getByText("Existing Codex")).toBeInTheDocument();
    expect(screen.getByText(/Existing access grant/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const disconnectButtons = screen.getAllByRole("button", {
      name: "Disconnect",
    });
    fireEvent.click(disconnectButtons.at(-1)!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/profile/mcp-connections",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
