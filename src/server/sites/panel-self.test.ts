import { afterEach, describe, expect, it, vi } from "vitest";
import { getPanelSelfDomain, isPanelSelfDomain } from "./panel-self";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("panel-self detection", () => {
  it("uses the deploy directory name as the panel's own domain", () => {
    vi.spyOn(process, "cwd").mockReturnValue(
      "/home/panelavo/htdocs/panel.1.2.3.4.example.com",
    );
    expect(getPanelSelfDomain()).toBe("panel.1.2.3.4.example.com");
    expect(isPanelSelfDomain("PANEL.1.2.3.4.Example.com")).toBe(true);
    expect(isPanelSelfDomain("site-20001.1.2.3.4.example.com")).toBe(false);
  });

  it("hides nothing when the directory name is not a domain (dev checkout)", () => {
    vi.spyOn(process, "cwd").mockReturnValue("/home/dev/panelavo");
    expect(getPanelSelfDomain()).toBeNull();
    expect(isPanelSelfDomain("panelavo")).toBe(false);
  });

  it("prefers the PANEL_SELF_DOMAIN override", () => {
    vi.stubEnv("PANEL_SELF_DOMAIN", "My-Panel.Example.com");
    expect(getPanelSelfDomain()).toBe("my-panel.example.com");
    expect(isPanelSelfDomain("my-panel.example.com")).toBe(true);
  });
});
