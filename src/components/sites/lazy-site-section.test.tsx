// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LazySiteSection } from "./lazy-site-section";

vi.mock("./site-section-manager", () => ({
  SiteSectionManager: ({ section }: { section: string }) => (
    <div>Loaded {section}</div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LazySiteSection", () => {
  it("loads only when its tab content is mounted", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ success: true, data: { files: [] } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <LazySiteSection
        domain="example.test"
        section="logs"
        title="Application logs"
        canWrite
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading application logs",
    );
    expect(await screen.findByText("Loaded logs")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sites/example.test/sections/logs",
    );
  });

  it("shows a recoverable load error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => ({
          success: false,
          error: { message: "Logs unavailable" },
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ success: true, data: { files: [] } }),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <LazySiteSection
        domain="example.test"
        section="logs"
        title="Application logs"
        canWrite
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Logs unavailable",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Loaded logs")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not load protected content without write access", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <LazySiteSection
        domain="example.test"
        section="logs"
        title="Application logs"
        canWrite={false}
      />,
    );
    expect(screen.queryByText("Application logs")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
