// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerResources } from "@/types/cloudpanel";
import { ResourcesView } from "./resources-view";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

function resources(): ServerResources {
  return {
    generatedAt: "2026-08-20T00:00:00.000Z",
    uptimeSeconds: 3600,
    cpu: { cores: 4, load1: 1, load5: 1, load15: 1, usedPercent: 25 },
    memory: { totalBytes: 16_000, usedBytes: 8_000, availableBytes: 8_000, usedPercent: 50 },
    swap: { totalBytes: 0, usedBytes: 0 },
    disk: { totalBytes: 100_000, usedBytes: 50_000, availableBytes: 50_000, usedPercent: 50, mount: "/" },
    users: [],
    websites: Array.from({ length: 12 }, (_, index) => ({
      domain: `site-${String(index + 1).padStart(2, "0")}.example.test`,
      siteUser: `site-${index + 1}`,
      type: index === 11 ? "docker" as const : "php" as const,
      cpuPercent: index,
      memoryBytes: (index + 1) * 100,
      processes: index === 0 ? 0 : index + 1,
      diskBytes: (index + 1) * 1000,
      diskShared: false,
      sources: index ? ["owner" as const] : [],
    })),
    shared: { cpuPercent: 1, memoryBytes: 200, processes: 2 },
    system: { cpuPercent: 2, memoryBytes: 300, processes: 3 },
    attribution: { memoryMethod: "pss", note: "Unresolved work remains separate." },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ResourcesView", () => {
  it("paginates and filters website rows without mixing in system users", () => {
    render(<ResourcesView initialData={resources()} initialHistory={[]} />);

    expect(screen.getByText("site-12.example.test")).toBeInTheDocument();
    expect(screen.queryByText("site-02.example.test")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("site-02.example.test")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Search websites" }), { target: { value: "site-01" } });
    expect(screen.getByText("site-01.example.test")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
    expect(screen.getByText(/Host services and processes with no safe website match/)).toBeInTheDocument();
    expect(screen.getByText(/without enough evidence for an honest split/)).toBeInTheDocument();
  });

  it("renders immediately and fills the page from the deferred snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({ success: true, data: { resources: resources(), history: [] } }),
    }));

    render(<ResourcesView initialData={null} initialHistory={[]} />);
    expect(screen.getByText("Measuring website usage…")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Website resource usage")).toBeInTheDocument());
  });
});
