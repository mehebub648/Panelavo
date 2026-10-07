// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { DeploymentKey } from "./deployment-key";

function response(value: unknown, ok = true) {
  return { ok, json: async () => value } as Response;
}

describe("DeploymentKey", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("recovers from a non-JSON reload response without exposing transport details", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected end of JSON input");
        },
      } as unknown as Response)
      .mockResolvedValueOnce(
        response({
          success: true,
          data: { keyPair: { publicKey: "ssh-ed25519 public-test-key" } },
        }),
      );

    render(<DeploymentKey domain="site.test" apiBase="" />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load the deployment key");
    expect(alert).not.toHaveTextContent("Unexpected end of JSON input");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(
      await screen.findByText("ssh-ed25519 public-test-key"),
    ).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(fetch).mock.calls) {
      expect(call[0]).toBe("/api/sites/site.test/sections/users");
      expect(call[1]).toBeUndefined();
    }
  });

  it("uses the same recoverable message for an unsuccessful read", async () => {
    vi.mocked(fetch).mockResolvedValue(
      response(
        {
          success: false,
          error: { message: "upstream proxy dumped internal transport data" },
        },
        false,
      ),
    );

    render(<DeploymentKey domain="site.test" apiBase="/remote" />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Retry in a moment");
    expect(alert).not.toHaveTextContent("internal transport data");
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(
      "/remote/api/sites/site.test/sections/users",
    );
  });
});
