// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DomainsManager } from "./domains-manager";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("website domains", () => {
  it("shows a retryable loading error and recovers without inventing a port", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => ({
          success: false,
          error: { message: "CloudPanel is temporarily unavailable." },
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          success: true,
          data: {
            meta: {
              id: 21001,
              category: "personal",
              aliases: [],
              block: "none",
            },
            serverIp: "203.0.113.10",
            dns: [
              {
                name: "site-21001.example.test",
                ip: "203.0.113.10",
                pointed: true,
              },
            ],
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DomainsManager domain="site-21001.example.test" canWrite={true} />,
    );

    expect(
      await screen.findByText("CloudPanel is temporarily unavailable."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Site id 21001/)).toHaveTextContent(
      "Site id 21001 · category personal",
    );
    expect(screen.queryByText(/port 21001/)).not.toBeInTheDocument();
  });
});
