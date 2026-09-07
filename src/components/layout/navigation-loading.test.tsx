// @vitest-environment jsdom
/* eslint-disable @next/next/no-html-link-for-pages -- Raw anchors exercise the document navigation listener. */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavigationLoading } from "./navigation-loading";
const route = vi.hoisted(() => ({
  pathname: "/servers/node",
  search: "tab=websites",
}));
vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
  useSearchParams: () => new URLSearchParams(route.search),
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe("navigation loading completion", () => {
  it("clears the overlay immediately when only the remote tab query changes", () => {
    vi.useFakeTimers();
    route.search = "tab=websites";
    window.history.replaceState({}, "", "/servers/node?tab=websites");
    const view = render(
      <>
        <NavigationLoading />
        <a href="/servers/node?tab=settings">Settings</a>
      </>,
    );
    fireEvent.click(screen.getByText("Settings"));
    expect(screen.queryByRole("status")).not.toBeNull();
    route.search = "tab=settings";
    view.rerender(
      <>
        <NavigationLoading />
        <a href="/servers/node?tab=settings">Settings</a>
      </>,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("does not block the page for history changes to an anchor on the same route", () => {
    route.search = "tab=settings";
    window.history.replaceState(
      {},
      "",
      "/servers/node?tab=settings#connected-servers",
    );
    render(<NavigationLoading />);
    fireEvent.popState(window);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
