import { describe, expect, it } from "vitest";
import {
  localSiteProxyUrl,
  managedApplicationPort,
  managedSiteIdForApplicationPort,
} from "./site-url";

describe("site URLs", () => {
  it("keeps the site id separate from the default application port", () => {
    expect(managedApplicationPort(24000)).toBe(34000);
    expect(managedSiteIdForApplicationPort(34000)).toBe(24000);
    expect(localSiteProxyUrl(24000)).toBe("http://127.0.0.1:34000");
  });

  it("does not invent a target before a site id is available", () => {
    expect(localSiteProxyUrl(null)).toBe("");
  });
});
