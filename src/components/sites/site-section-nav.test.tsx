// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SiteSectionNav } from "./site-section-nav";

let pathname = "/sites/example.test/settings";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.ComponentProps<"a">) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
  pathname = "/sites/example.test/settings";
});

describe("site section navigation", () => {
  it("keeps common tasks primary and portals advanced developer tools", () => {
    render(<SiteSectionNav domain="example.test" />);

    expect(screen.getByRole("link", { name: /Settings/ })).toBeVisible();
    expect(screen.getByRole("link", { name: /Files/ })).toBeVisible();
    expect(screen.getByRole("link", { name: /Backups/ })).toBeVisible();
    const developerTools = screen.getByRole("button", {
      name: "Developer tools",
    });
    expect(developerTools).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: /Vhost/ })).not.toBeInTheDocument();
    fireEvent.keyDown(developerTools, { key: "Enter" });
    expect(developerTools).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "Developer tools" });
    expect(menu).toHaveClass("z-[80]");
    expect(menu.closest("nav")).toBeNull();
    expect(screen.getByRole("menuitem", { name: /Vhost/ })).toHaveAttribute(
      "href",
      "/sites/example.test/vhost",
    );
    expect(screen.getByRole("menuitem", { name: /Git & Deploy/ })).toHaveAttribute(
      "href",
      "/sites/example.test/git",
    );
    expect(screen.getByRole("menuitem", { name: /Terminal/ })).toHaveAttribute(
      "href",
      "/sites/example.test/terminal",
    );
  });

  it("names the active developer section after deep-link navigation", () => {
    pathname = "/sites/example.test/git";
    const view = render(<SiteSectionNav domain="example.test" />);
    const developerTools = screen.getByRole("button", {
      name: "Developer tools: Git & Deploy",
    });
    expect(developerTools).toHaveAttribute(
      "aria-current",
      "page",
    );
    fireEvent.keyDown(developerTools, { key: "Enter" });
    expect(screen.getByRole("menuitem", { name: /Git & Deploy/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    pathname = "/sites/example.test/terminal";
    view.rerender(<SiteSectionNav domain="example.test" />);
    expect(screen.getByRole("button", { name: "Developer tools: Terminal" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("keeps project endpoints limited to their supported common tasks", () => {
    render(<SiteSectionNav domain="service.example.test" serviceSite />);
    expect(screen.getByRole("link", { name: /Settings/ })).toBeVisible();
    expect(screen.getByRole("link", { name: /Domains/ })).toBeVisible();
    expect(screen.getByRole("link", { name: /Security/ })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Developer tools/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Backups/ })).not.toBeInTheDocument();
  });
});
