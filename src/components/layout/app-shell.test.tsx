// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudPanelUser, PanelRole } from "@/types/cloudpanel";
import { AppShell } from "./app-shell";

const navigation = vi.hoisted(() => ({
  pathname: "/sites",
  tab: "",
  push: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams({ tab: navigation.tab }),
  useRouter: () => ({
    push: navigation.push,
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
}));
vi.mock("@/components/brand", () => ({ Brand: () => <span>Panelavo</span> }));
beforeEach(() => {
  navigation.pathname = "/sites";
  navigation.tab = "";
  navigation.push.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      json: async () => ({
        success: true,
        data: {
          outgoing: [
            { id: "node-a", label: "Second server", fullAccess: true },
          ],
        },
      }),
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function user(panelRole: PanelRole): CloudPanelUser {
  return {
    id: panelRole,
    username: panelRole,
    panelRole,
    canCreateSites: panelRole !== "user",
  };
}

describe("Fleet navigation visibility", () => {
  it("renders the complete local navigation for a Super Admin", () => {
    render(
      <AppShell user={user("super-admin")}>
        <p>Node content</p>
      </AppShell>,
    );
    for (const label of [
      "Websites",
      "Domains",
      "AI access",
      "Resources",
      "Information",
      "VPN",
      "About",
      "Users",
      "Audit",
      "Settings",
    ])
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(screen.getByRole("link", { name: "Switch server" })).toHaveAttribute(
      "href",
      "/switch-server?from=%2Fsites",
    );
  });
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
      expect(screen.queryByLabelText("Switch server")).not.toBeInTheDocument();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("replaces the sidebar profile with switching, without a Fleet page", async () => {
    render(
      <AppShell user={user("super-admin")}>
        <p>Content</p>
      </AppShell>,
    );
    expect(
      screen.queryByRole("link", { name: "Fleet" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Manage connections on this panel" }),
    ).toHaveAttribute("href", "/settings#connected-servers");
    expect(screen.getByRole("link", { name: "Switch server" })).toHaveAttribute(
      "href",
      "/switch-server?from=%2Fsites",
    );
    expect(
      screen.queryByRole("combobox", { name: "Switch server" }),
    ).not.toBeInTheDocument();
  });

  it("switches servers and points all server navigation at the selected Node", async () => {
    navigation.pathname = "/servers/node-a";
    navigation.tab = "resources";
    render(
      <AppShell user={user("super-admin")}>
        <p>Content</p>
      </AppShell>,
    );
    await screen.findAllByText("Second server");
    expect(screen.getByLabelText("Switch server")).toHaveAttribute(
      "href",
      "/switch-server?from=%2Fservers%2Fnode-a%3Ftab%3Dresources",
    );
    expect(screen.getByRole("link", { name: "Websites" })).toHaveAttribute(
      "href",
      "/servers/node-a?tab=websites",
    );
    expect(screen.getByRole("link", { name: "Users" })).toHaveAttribute(
      "href",
      "/servers/node-a?tab=users",
    );
    for (const label of [
      "Websites",
      "Domains",
      "AI access",
      "Resources",
      "Information",
      "VPN",
      "About",
      "Users",
      "Audit",
      "Settings",
    ])
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/servers/node-a?tab=settings",
    );
  });

  it("keeps local management available if discovery fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    render(
      <AppShell user={user("super-admin")}>
        <p>Local content</p>
      </AppShell>,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(screen.getByRole("link", { name: "Websites" })).toHaveAttribute(
      "href",
      "/sites",
    );
    expect(screen.getByText("Local content")).toBeInTheDocument();
  });
});
