import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getMcpPublicUrlsFromHeaders,
  mcpAuthorizationServerMetadata,
  mcpProtectedResourceMetadata,
} from "./public-url";

describe("MCP public URLs", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses one canonical HTTPS origin in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PANEL_SELF_DOMAIN", "panel.example.com");
    const urls = getMcpPublicUrlsFromHeaders(
      new Headers({
        host: "panel.example.com",
        "x-forwarded-proto": "https",
      }),
    );
    expect(urls).toMatchObject({
      issuer: "https://panel.example.com",
      resource: "https://panel.example.com/mcp",
      tokenEndpoint: "https://panel.example.com/oauth/token",
    });
    expect(mcpProtectedResourceMetadata(urls)).toMatchObject({
      resource: urls.resource,
      authorization_servers: [urls.issuer],
    });
    expect(mcpAuthorizationServerMetadata(urls)).toMatchObject({
      issuer: urls.issuer,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  it("rejects an insecure or unexpected production address", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PANEL_SELF_DOMAIN", "panel.example.com");
    expect(() =>
      getMcpPublicUrlsFromHeaders(
        new Headers({
          host: "panel.example.com",
          "x-forwarded-proto": "http",
        }),
      ),
    ).toThrow(/HTTPS/);
    expect(() =>
      getMcpPublicUrlsFromHeaders(
        new Headers({
          host: "other.example.com",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toThrow(/unexpected host/);
    expect(() =>
      getMcpPublicUrlsFromHeaders(new Headers({ host: "panel.example.com" })),
    ).toThrow(/protocol/);
  });

  it("allows the loopback upstream only when it names the configured public host", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PANEL_SELF_DOMAIN", "panel.example.com");
    expect(
      getMcpPublicUrlsFromHeaders(
        new Headers({
          host: "127.0.0.1:10443",
          "x-forwarded-host": "panel.example.com",
          "x-forwarded-proto": "https",
        }),
      ).origin,
    ).toBe("https://panel.example.com");
    expect(() =>
      getMcpPublicUrlsFromHeaders(
        new Headers({
          host: "127.0.0.1:10443",
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toThrow(/unexpected public host/);
  });
});
