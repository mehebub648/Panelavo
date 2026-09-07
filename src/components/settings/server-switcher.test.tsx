// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerSwitcher } from "./server-switcher";
vi.mock("next/navigation", () => ({
  useSearchParams: () =>
    new URLSearchParams({ from: "/servers/production?tab=resources" }),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("server selection page", () => {
  it("shows nicknames, searches servers, and preserves the selected section", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({
          success: true,
          data: {
            outgoing: [
              {
                id: "production",
                label: "Production",
                origin: "https://prod.example.com",
                status: "online",
                fullAccess: true,
              },
            ],
          },
        }),
      }),
    );
    render(<ServerSwitcher />);
    const remote = await screen.findByRole("link", { name: /Production/ });
    expect(remote).toHaveAttribute("href", "/servers/production?tab=resources");
    expect(screen.getByRole("link", { name: /This server/ })).toHaveAttribute(
      "href",
      "/resources",
    );
    expect(screen.getByText("Current")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search servers"), {
      target: { value: "prod.example.com" },
    });
    expect(
      screen.queryByRole("link", { name: /This server/ }),
    ).not.toBeInTheDocument();
    expect(remote).toBeInTheDocument();
  });
  it("keeps local management selectable when remote discovery fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unavailable")));
    render(<ServerSwitcher />);
    await screen.findByRole("alert");
    expect(screen.getByRole("link", { name: /This server/ })).toHaveAttribute(
      "href",
      "/resources",
    );
  });
});
