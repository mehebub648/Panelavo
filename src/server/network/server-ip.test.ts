import { describe, expect, it } from "vitest";
import { requestHostFallback } from "./server-ip";

function request(forwardedHost: string | null, hostname = "fallback.test") {
  return {
    headers: {
      get: (name: string) =>
        name === "x-forwarded-host" ? forwardedHost : null,
    },
    nextUrl: { hostname },
  };
}

describe("requestHostFallback", () => {
  it("uses the first forwarded host without its port", () => {
    expect(requestHostFallback(request("203.0.113.10:443, proxy.local"))).toBe(
      "203.0.113.10",
    );
  });

  it("falls back to the request URL hostname", () => {
    expect(requestHostFallback(request(null))).toBe("fallback.test");
  });
});
