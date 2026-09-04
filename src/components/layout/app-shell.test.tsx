// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudPanelUser, PanelRole } from "@/types/cloudpanel";
import { AppShell } from "./app-shell";

vi.mock("next/navigation", () => ({
  usePathname: () => "/sites",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/components/brand", () => ({ Brand: () => <span>Panelavo</span> }));
afterEach(cleanup);

function user(panelRole: PanelRole): CloudPanelUser {
  return {
    id: panelRole,
    username: panelRole,
    panelRole,
    canCreateSites: panelRole !== "user",
  };
}

describe("Fleet navigation visibility", () => {
  it.each(["manager", "admin", "user"] as const)(
    "does not disclose Fleet to %s",
    (role) => {
      render(
        <AppShell user={user(role)}>
          <p>Content</p>
        </AppShell>,
      );
      expect(
        screen.queryByRole("link", { name: "Fleet" }),
      ).not.toBeInTheDocument();
    },
  );

  it("shows Fleet to Super Admins", () => {
    render(
      <AppShell user={user("super-admin")}>
        <p>Content</p>
      </AppShell>,
    );
    expect(
      screen.getAllByRole("link", { name: "Fleet" }).length,
    ).toBeGreaterThan(0);
  });
});
