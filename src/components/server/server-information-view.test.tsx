// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ServerInformationView } from "./server-information-view";
import type { ServerInformation } from "@/types/cloudpanel";

vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shows the complete server inventory and copies details", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(
    <ServerInformationView
      info={
        {
          hostname: "remote-1",
          panelAddress: "https://panel.remote.example",
          ip: "203.0.113.8",
          ipv4Addresses: ["203.0.113.8"],
          ipv6Addresses: ["2001:db8::8"],
          os: "Ubuntu 24.04 LTS",
          kernel: "6.8.0",
          arch: "x86_64",
          cpuModel: "AMD EPYC",
          cpuCores: 4,
          memoryTotalBytes: 16 * 1024 ** 3,
          diskTotalBytes: 200 * 1024 ** 3,
          uptimeSeconds: 90_000,
          software: [{ name: "Node.js", version: "v26.8.1" }],
          maintenance: {
            status: "current",
            rebootRequired: false,
            securityUpdates: 0,
            availableUpdates: 0,
            unattendedUpgrades: true,
            checkedAt: new Date().toISOString(),
          },
        } satisfies ServerInformation
      }
    />,
  );

  expect(screen.getByText("Panel address")).toBeTruthy();
  expect(screen.getByText("IPv4 address")).toBeTruthy();
  expect(screen.getByText("IPv6 address")).toBeTruthy();
  expect(screen.getByText("16.0 GB")).toBeTruthy();
  expect(screen.getByText("200.0 GB")).toBeTruthy();
  expect(screen.getByText("Node.js")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: /panel\.remote\.example/i }),
  );
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith("https://panel.remote.example"),
  );
});

it("keeps older connected-panel responses readable during rollout", () => {
  render(
    <ServerInformationView
      info={
        {
          hostname: "older-node",
          ip: "203.0.113.9",
          os: "Ubuntu",
          kernel: "6.8",
          arch: "x86_64",
          cpuModel: "AMD EPYC",
          cpuCores: 2,
          memoryTotalBytes: 1024,
          diskTotalBytes: 2048,
          uptimeSeconds: 60,
          software: [],
        } as unknown as ServerInformation
      }
    />,
  );
  expect(screen.getByText("203.0.113.9")).toBeTruthy();
  expect(screen.getByText("Not configured")).toBeTruthy();
  expect(screen.getByText("Not available")).toBeTruthy();
});
