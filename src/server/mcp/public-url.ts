import { getPanelSelfDomain } from "@/server/sites/panel-self";

export type McpPublicUrls = {
  origin: string;
  issuer: string;
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint: string;
  resourceMetadataEndpoint: string;
};

function firstHeaderValue(value: string | null) {
  return value?.split(",")[0]?.trim() ?? "";
}

function validHost(value: string) {
  if (!value || value.length > 255 || /[\s/@\\?#]/.test(value)) return null;
  try {
    const url = new URL(`https://${value}`);
    return url.pathname === "/" && !url.search && !url.hash ? url : null;
  } catch {
    return null;
  }
}

function normalizedHostname(hostname: string) {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isLoopback(hostname: string) {
  const value = normalizedHostname(hostname);
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

export function getMcpPublicUrlsFromHeaders(headers: Headers): McpPublicUrls {
  const rawHost = headers.get("host")?.trim() ?? "";
  const host = validHost(rawHost);
  if (!host)
    throw new Error("Panelavo could not determine its public MCP address.");

  const production = process.env.NODE_ENV === "production";
  const forwardedProto = firstHeaderValue(headers.get("x-forwarded-proto"));
  const protocol = forwardedProto || (production ? "" : "http");
  if (!["http", "https"].includes(protocol))
    throw new Error("Panelavo received an invalid public protocol.");

  let origin: string;
  if (production) {
    const expectedHost = getPanelSelfDomain();
    const proxiedLoopback = isLoopback(host.hostname);
    if (
      !expectedHost ||
      (host.hostname.toLowerCase() !== expectedHost && !proxiedLoopback)
    ) {
      throw new Error("Panelavo received a request for an unexpected host.");
    }
    if (
      proxiedLoopback &&
      normalizedHostname(
        firstHeaderValue(headers.get("x-forwarded-host")).replace(/:\d+$/, ""),
      ) !== expectedHost
    )
      throw new Error(
        "Panelavo received a request for an unexpected public host.",
      );
    if (
      protocol !== "https" ||
      (!proxiedLoopback && host.port && host.port !== "443")
    ) {
      throw new Error(
        "Panelavo MCP is available only through its public HTTPS address.",
      );
    }
    origin = `https://${expectedHost}`;
  } else {
    origin = `${protocol}://${host.host}`;
  }

  const resource = `${origin}/mcp`;
  return {
    origin,
    issuer: origin,
    resource,
    authorizationEndpoint: `${origin}/oauth/authorize`,
    tokenEndpoint: `${origin}/oauth/token`,
    registrationEndpoint: `${origin}/oauth/register`,
    revocationEndpoint: `${origin}/oauth/revoke`,
    resourceMetadataEndpoint: `${origin}/.well-known/oauth-protected-resource/mcp`,
  };
}

export function getMcpPublicUrls(request: Request) {
  return getMcpPublicUrlsFromHeaders(request.headers);
}

export function mcpProtectedResourceMetadata(urls: McpPublicUrls) {
  return {
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    scopes_supported: ["panelavo:access"],
    bearer_methods_supported: ["header"],
    resource_documentation: `${urls.origin}/ai-access`,
  };
}

export function mcpAuthorizationServerMetadata(urls: McpPublicUrls) {
  return {
    issuer: urls.issuer,
    authorization_endpoint: urls.authorizationEndpoint,
    token_endpoint: urls.tokenEndpoint,
    registration_endpoint: urls.registrationEndpoint,
    revocation_endpoint: urls.revocationEndpoint,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["panelavo:access"],
  };
}
