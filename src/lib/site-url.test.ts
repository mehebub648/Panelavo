import { describe, expect, it } from "vitest";
import { localSiteProxyUrl } from "./site-url";

describe("site URLs", () => {
  it("uses the reserved site id as the default local proxy port", () => {
    expect(localSiteProxyUrl(24000)).toBe("http://127.0.0.1:24000");
  });

  it("does not invent a target before a site id is available", () => {
    expect(localSiteProxyUrl(null)).toBe("");
  });
});
