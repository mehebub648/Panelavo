// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
  it("keeps common tasks primary and groups advanced developer tools", () => {
    render(<SiteSectionNav domain="example.test" />);

    expect(screen.getByRole("link", { name: /Settings/ })).toBeVisible();
    expect(screen.getByRole("link", { name: /Files/ })).toBeVisible();
    expect(screen.getByRole("link", { name: /Backups/ })).toBeVisible();
    expect(screen.getByText("Developer tools").closest("summary")).toBeVisible();
    expect(screen.getByRole("link", { name: /Vhost/ })).toHaveAttribute(
      "href",
      "/sites/example.test/vhost",
    );
    expect(screen.getByRole("link", { name: /Git & Deploy/ })).toHaveAttribute(
      "href",
      "/sites/example.test/git",
    );
    expect(screen.getByRole("link", { name: /Terminal/ })).toHaveAttribute(
      "href",
      "/sites/example.test/terminal",
    );
  });

  it("names the active developer section after deep-link navigation", () => {
    pathname = "/sites/example.test/git";
    const view = render(<SiteSectionNav domain="example.test" />);
    expect(screen.getByText("Developer tools: Git & Deploy")).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: /Git & Deploy/ })).toHaveAttribute(
      "aria-current",
      "page",
    );

    pathname = "/sites/example.test/terminal";
    view.rerender(<SiteSectionNav domain="example.test" />);
    expect(screen.getByText("Developer tools: Terminal")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("keeps project endpoints limited to their supported common tasks", () => {
    render(<SiteSectionNav domain="service.example.test" serviceSite />);
    expect(screen.getByRole("link", { name: /Settings/ })).toBeVisible();
    expect(screen.getByRole("link", { name: /Domains/ })).toBeVisible();
    expect(screen.getByRole("link", { name: /Security/ })).toBeVisible();
    expect(screen.queryByText(/Developer tools/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Backups/ })).not.toBeInTheDocument();
  });
});
