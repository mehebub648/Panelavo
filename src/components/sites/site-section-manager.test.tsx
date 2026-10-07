// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SiteSectionManager } from "./site-section-manager";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(cleanup);

describe("certificate display", () => {
  it("shows certificate state without a second issuance or activation workflow", () => {
    render(
      <SiteSectionManager
        domain="site.example.test"
        section="certificates"
        displayOnly
        initialData={{
          items: [
            {
              id: "certificate-1",
              type: "lets-encrypt",
              domains: ["site.example.test", "example.test"],
              expiresAt: "2027-01-01T00:00:00Z",
              default: false,
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("site.example.test, example.test")).toBeVisible();
    expect(screen.getByText("Inactive")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Issue certificate" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Activate" }),
    ).not.toBeInTheDocument();
  });
});
