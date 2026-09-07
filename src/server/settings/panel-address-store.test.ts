import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPanelAddressState,
  savePanelAddressState,
} from "./panel-address-store";
import {
  getPanelPublicDomain,
  isPanelSelfDomain,
} from "@/server/sites/panel-self";
import { getMcpPublicUrlsFromHeaders } from "@/server/mcp/public-url";

describe("verified panel address persistence", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "panel-address-"));
    vi.stubEnv("PANEL_DATA_DIR", directory);
    vi.stubEnv("PANEL_SELF_DOMAIN", "old.example.com");
    vi.stubEnv("NODE_ENV", "production");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  it("retains the deployment domain and publishes the verified canonical origin", () => {
    savePanelAddressState({
      origin: "https://new.example.com",
      previousOrigins: ["https://old.example.com"],
      revision: 1,
    });
    expect(getPanelAddressState().revision).toBe(1);
    expect(getPanelPublicDomain()).toBe("new.example.com");
    expect(isPanelSelfDomain("old.example.com")).toBe(true);
    expect(isPanelSelfDomain("new.example.com")).toBe(true);
    expect(isPanelSelfDomain("site.example.com")).toBe(false);
    for (const host of ["new.example.com", "old.example.com"])
      expect(
        getMcpPublicUrlsFromHeaders(
          new Headers({ host, "x-forwarded-proto": "https" }),
        ).issuer,
      ).toBe("https://new.example.com");
    expect(() =>
      getMcpPublicUrlsFromHeaders(
        new Headers({
          host: "attacker.example.com",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toThrow(/unexpected host/);
  });
  it("persists pending progress without changing the canonical address", () => {
    savePanelAddressState({
      previousOrigins: [],
      revision: 0,
      pending: {
        origin: "https://new.example.com",
        previousOrigin: "https://old.example.com",
        revision: 1,
        completed: ["peer"],
      },
    });
    expect(getPanelPublicDomain()).toBe("old.example.com");
    expect(getPanelAddressState().pending?.completed).toEqual(["peer"]);
    expect(isPanelSelfDomain("new.example.com")).toBe(true);
  });
});
