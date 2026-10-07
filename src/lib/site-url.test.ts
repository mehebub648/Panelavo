import { describe, expect, it } from "vitest";
import {
  createdSiteRedirectUrl,
  localSiteProxyUrl,
  managedApplicationPort,
  managedSiteIdForApplicationPort,
  managedSiteIdsForExistingApplicationPort,
} from "./site-url";

describe("site URLs", () => {
  it("uses the site id as the default application port", () => {
    expect(managedApplicationPort(24000)).toBe(24000);
    expect(managedSiteIdForApplicationPort(24000)).toBe(24000);
    expect(managedSiteIdForApplicationPort(34000)).toBeNull();
    expect(localSiteProxyUrl(24000)).toBe("http://127.0.0.1:24000");
  });

  it("keeps legacy id-plus-10000 ports reserved for existing websites", () => {
    expect(managedSiteIdsForExistingApplicationPort(24000)).toEqual([24000]);
    expect(managedSiteIdsForExistingApplicationPort(34000)).toEqual([24000]);
    expect(managedSiteIdsForExistingApplicationPort(8080)).toEqual([]);
  });

  it("does not invent a target before a site id is available", () => {
    expect(localSiteProxyUrl(null)).toBe("");
  });

  it("carries the server-assigned port into local and fleet success routes", () => {
    expect(
      createdSiteRedirectUrl("/sites", {
        domain: "site-20004.example.test",
        type: "nodejs",
        port: 30004,
      }),
    ).toBe(
      "/sites?created=site-20004.example.test&createdType=nodejs&createdPort=30004",
    );
    expect(
      createdSiteRedirectUrl("/servers/remote?tab=websites", {
        domain: "site-21000.example.test",
        type: "docker",
        port: 31000,
      }),
    ).toBe(
      "/servers/remote?tab=websites&created=site-21000.example.test&createdType=docker&createdPort=31000",
    );
  });
});
