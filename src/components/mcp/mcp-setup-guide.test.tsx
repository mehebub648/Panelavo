// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

afterEach(cleanup);

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
    const desktop = screen.getByRole("tab", { name: "Desktop app" });
    expect(desktop).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(desktop, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Command line" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText(/codex mcp add panelavo/)).toBeInTheDocument();
  });
});
