import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AppError } from "@/server/cloudpanel/errors";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  pluginUrls: vi.fn(),
  buildPanelavoPluginZip: vi.fn(),
}));

vi.mock("@/server/auth/require-user", () => ({
  requireUser: mocks.requireUser,
}));
vi.mock("@/server/plugin/config", () => ({
  pluginUrls: mocks.pluginUrls,
}));
vi.mock("@/server/plugin/package", () => ({
  buildPanelavoPluginZip: mocks.buildPanelavoPluginZip,
}));

import { GET } from "./route";

describe("Panelavo plugin download", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ user: { id: "user-1" } });
    mocks.pluginUrls.mockReturnValue({
      origin: "https://selected.panel.example",
      resource: "https://selected.panel.example/connect/openai/mcp",
    });
    mocks.buildPanelavoPluginZip.mockResolvedValue(Buffer.from("plugin-zip"));
  });

  it("requires a panel user and packages the selected hosted connection", async () => {
    const request = new NextRequest(
      "https://selected.panel.example/api/profile/panelavo-plugin",
    );
    const response = await GET(request);

    expect(mocks.requireUser).toHaveBeenCalledWith({
      allowDuringUpdate: true,
    });
    expect(mocks.pluginUrls).toHaveBeenCalledWith(request);
    expect(mocks.buildPanelavoPluginZip).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: "https://selected.panel.example/connect/openai/mcp",
      }),
    );
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toContain(
      "panelavo-plugin.zip",
    );
  });

  it("returns the hosted-service prerequisite without creating an archive", async () => {
    mocks.pluginUrls.mockImplementationOnce(() => {
      throw new AppError(
        "INVALID_REQUEST",
        "A server administrator must set PANELAVO_PLUGIN_ENABLED=1 and reload Panelavo.",
        404,
      );
    });

    const response = await GET(
      new NextRequest(
        "https://selected.panel.example/api/profile/panelavo-plugin",
      ),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          message: expect.stringContaining("PANELAVO_PLUGIN_ENABLED=1"),
        }),
      }),
    );
    expect(mocks.buildPanelavoPluginZip).not.toHaveBeenCalled();
  });
});
