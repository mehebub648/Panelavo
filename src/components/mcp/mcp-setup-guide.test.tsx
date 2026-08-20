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

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/components/ui/copy-value", () => ({
  CopyValue: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

  it("shows friendly setup choices and supports keyboard tab navigation", () => {
    render(
      <McpSetupGuide
        user={user("admin")}
        endpoint="https://panel.example.com/mcp"
        initialConnections={[]}
      />,
    );

    expect(screen.getByText("Connect an AI assistant")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Account security, Panelavo account management, and panel settings/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No AI assistants are connected yet"),
    ).toBeInTheDocument();
    const windows = screen.getByRole("tab", { name: "Windows" });
    expect(windows).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(windows, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "macOS / Linux" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getAllByText(/codex mcp add panelavo/)).not.toHaveLength(0);
  });

  it("reveals a generated bearer token once and inserts it into setup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({
          success: true,
          data: {
            token: "pnl_mpat.generated-secret",
            connection: {
              id: "3b0c4b0f-e4de-49ba-8aa7-b146675cd752",
              clientId: "pnl_personal_3b0c4b0f-e4de-49ba-8aa7-b146675cd752",
              clientName: "My Codex",
              kind: "personal-token",
              createdAt: Date.now(),
              expiresAt: Date.now() + 90 * 86_400_000,
            },
          },
        }),
      }),
    );
    render(
      <McpSetupGuide
        user={user("admin")}
        endpoint="https://panel.example.com/mcp"
        initialConnections={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Generate token/ }));

    await waitFor(() =>
      expect(
        screen.getByText(/Panelavo will not show it again/),
      ).toBeInTheDocument(),
    );
    expect(screen.getAllByText(/pnl_mpat\.generated-secret/)).not.toHaveLength(
      0,
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/profile/mcp-connections",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
