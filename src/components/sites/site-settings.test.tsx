// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SiteSettings } from "./site-settings";
import type { CloudPanelSite } from "@/types/cloudpanel";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./uptime-settings", () => ({ UptimeSettings: () => null }));
const site: CloudPanelSite = {
  id: "1",
  domain: "site.test",
  url: "https://site.test",
  type: "docker",
  rootDirectory: "site.test",
  applicationRootDirectory: "site.test/app",
  reverseProxyUrl: "http://127.0.0.1:34000",
  siteUser: "site-user",
  status: "active",
};
function show() {
  render(
    <SiteSettings
      initialSite={site}
      user={{ id: "1", username: "admin", canCreateSites: true }}
      uptime={{
        config: { enabled: false, intervalMinutes: 5 },
        state: { status: "unknown", failures: 0, alerted: false },
      }}
    />,
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("website settings", () => {
  it("sends only a label change and leaves traffic settings alone", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({
        json: async () => ({
          success: true,
          data: { site: { ...site, label: "New label" } },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    show();
    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "New label" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      label: "New label",
    });
  });
  it("requires an exact old-to-new routing confirmation before submitting", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({
        json: async () => ({
          success: true,
          data: {
            site: { ...site, reverseProxyUrl: "http://127.0.0.1:24000" },
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    show();
    fireEvent.click(
      screen.getByText("Advanced: public folder and website routing"),
    );
    fireEvent.change(screen.getByLabelText("Website upstream"), {
      target: { value: "http://127.0.0.1:24000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "http://127.0.0.1:34000 to http://127.0.0.1:24000",
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      reverseProxyUrl: "http://127.0.0.1:24000",
    });
  });
});
