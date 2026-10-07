import { getMcpPublicUrls, type McpPublicUrls } from "@/server/mcp/public-url";
import { AppError } from "@/server/cloudpanel/errors";

export function pluginUrls(request: Request): McpPublicUrls {
  if (process.env.PANELAVO_PLUGIN_ENABLED !== "1")
    throw new AppError(
      "INVALID_REQUEST",
      "The Panelavo plugin service is not enabled.",
      404,
    );
  const { origin } = getMcpPublicUrls(request);
  return {
    origin,
    issuer: `${origin}/connect`,
    resource: `${origin}/connect/openai/mcp`,
    authorizationEndpoint: `${origin}/connect/authorize`,
    tokenEndpoint: `${origin}/connect/token`,
    registrationEndpoint: `${origin}/connect/register`,
    revocationEndpoint: `${origin}/connect/revoke`,
    resourceMetadataEndpoint: `${origin}/.well-known/oauth-protected-resource/connect/openai/mcp`,
  };
}

export const PLUGIN_COOKIE = "__Host-panelavo_plugin";
export const GROUP_LIFETIME = 30 * 24 * 60 * 60_000;
export const LOGIN_LIFETIME = 10 * 60_000;
