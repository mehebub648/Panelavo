// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerResources, ServerStorageBreakdown } from "@/types/cloudpanel";
import { ResourcesView } from "./resources-view";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

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

function storage(): ServerStorageBreakdown {
  return {
    generatedAt: "2026-08-21T00:00:00.000Z",
    totalBytes: 200_000,
    usedBytes: 140_000,
    availableBytes: 60_000,
    reservedBytes: 0,
    accountedBytes: 130_000,
    groups: [
      {
        id: "site-users",
        label: "Site users",
        bytes: 120_000,
        description: "Complete site-user homes.",
        details: [{
          label: "site-24003",
          bytes: 100_000,
          note: "example.test. Includes Docker data.",
          metrics: [{ label: "Build Cache", value: "23.3GB", reclaimable: "17.26GB" }],
        }],
      },
      {
        id: "other",
        label: "Other and filesystem overhead",
        bytes: 20_000,
        description: "Unclassified data.",
        details: [],
      },
    ],
    note: "Directory totals use allocated blocks.",
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

  it("loads complete storage groups only when disk details are opened", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ success: true, data: { storage: storage() } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ResourcesView initialData={resources()} initialHistory={[]} />);
    fireEvent.click(screen.getByText("Disk (/)").closest("button")!);

    await waitFor(() => expect(screen.getByText("Storage breakdown")).toBeInTheDocument());
    expect(await screen.findByText("Site users")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Show details"));
    expect(screen.getByText("site-24003")).toBeInTheDocument();
    expect(screen.getByText(/reclaimable 17.26GB/)).toHaveTextContent("23.3GB");
    expect(fetchMock).toHaveBeenCalledWith("/api/server/storage", {
      method: "GET",
      cache: "no-store",
    });
  });

  it("confirms and reports bounded build-cache cleanup for super administrators", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => Promise.resolve({
      json: async () => url.endsWith("/reclaim")
        ? {
            success: true,
            data: {
              cleanup: {
                generatedAt: "2026-08-21T01:00:00.000Z",
                reclaimedBytes: 40_000,
                retainedBuildCacheBytes: 5_000_000_000,
                sites: [{ user: "site-24003", domains: ["example.test"], status: "cleaned", reclaimed: "13GB", message: "Unused layers removed." }],
                note: "Volumes and application files were preserved.",
              },
            },
          }
        : { success: true, data: { storage: storage() } },
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ResourcesView initialData={resources()} initialHistory={[]} canReclaimStorage />);
    fireEvent.click(screen.getByText("Disk (/)").closest("button")!);
    await screen.findByText("Storage breakdown");
    fireEvent.click(screen.getByRole("button", { name: "Reclaim build cache" }));
    expect(screen.getByText("Reclaim unused build cache?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reclaim cache" }));

    await screen.findByText("Last cleanup recovered 39.1 KB");
    expect(fetchMock).toHaveBeenCalledWith("/api/server/storage/reclaim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "RECLAIM BUILD CACHE" }),
    });
    expect(screen.getByText(/Volumes and application files were preserved/)).toBeInTheDocument();
  });
});
