import { describe, expect, it } from "vitest";
import {
  fleetSection,
  selectedFleetServer,
  switchFleetServer,
} from "./fleet-navigation";

describe("server switching", () => {
  it.each([
    "domains",
    "ai-access",
    "resources",
    "information",
    "vpn",
    "about",
    "users",
    "audit",
    "settings",
  ])(
    "preserves %s across local and remote servers",
    (section) => {
      expect(switchFleetServer("node-a", `/${section}`)).toBe(
        `/servers/node-a?tab=${section}`,
      );
      expect(
        switchFleetServer("node-b", "/servers/node-a", section),
      ).toBe(`/servers/node-b?tab=${section}`);
      expect(switchFleetServer("local", "/servers/node-a", section)).toBe(
        `/${section}`,
      );
    },
  );
  it("never carries a website identity across servers", () => {
    expect(
      switchFleetServer(
        "node-b",
        "/servers/node-a/sites/example.com/files",
      ),
    ).toBe("/servers/node-b?tab=websites");
    expect(
      switchFleetServer(
        "local",
        "/servers/node-a/sites/example.com/settings",
      ),
    ).toBe("/sites");
  });
  it("preserves creation and maps remote updates back to local settings", () => {
    expect(switchFleetServer("node-a", "/sites/new")).toBe(
      "/servers/node-a/sites/new",
    );
    expect(switchFleetServer("local", "/servers/node-a/sites/new")).toBe(
      "/sites/new",
    );
    expect(switchFleetServer("local", "/servers/node-a", "updates")).toBe(
      "/settings",
    );
  });
  it("derives the target from the route, not remembered browser state", () => {
    expect(selectedFleetServer("/servers/node-a/sites/new")).toBe(
      "node-a",
    );
    expect(selectedFleetServer("/profile")).toBe("local");
    expect(selectedFleetServer("/fleet")).toBe("local");
    expect(fleetSection("invalid")).toBe("websites");
  });
});
