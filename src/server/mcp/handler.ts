import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import { resolveMcpActor } from "@/server/mcp/oauth";
import { createPanelavoMcpServer } from "@/server/mcp/server";
import { getMcpPublicUrls } from "@/server/mcp/public-url";
import { createLegacyMcpHandler } from "./legacy-handler";

function getActor(authInfo?: AuthInfo) {
  if (!authInfo) throw new Error("MCP authentication is required.");
  return resolveMcpActor(authInfo);
}

const handler = createMcpHandler(
  ({ authInfo }) => createPanelavoMcpServer(getActor(authInfo)),
  {
    legacy: "reject",
    responseMode: "auto",
    onerror(error) {
      console.error("MCP request failed:", error.message);
    },
  },
);

const legacyHandler = createLegacyMcpHandler((authInfo) =>
  createPanelavoMcpServer(getActor(authInfo)),
);

function allowedHostname(request: Request) {
  return new URL(getMcpPublicUrls(request).origin).hostname;
}

export function validateMcpRequestOrigin(request: Request) {
  const host = allowedHostname(request);
  const hostHeader = request.headers.get("host")?.split(":")[0]?.toLowerCase();
  const productionLoopbackProxy =
    process.env.NODE_ENV === "production" &&
    (hostHeader === "127.0.0.1" ||
      hostHeader === "localhost" ||
      hostHeader === "[::1]");
  return (
    (productionLoopbackProxy
      ? undefined
      : hostHeaderValidationResponse(request, [host])) ??
    (productionLoopbackProxy
      ? undefined
      : originValidationResponse(request, [host]))
  );
}

export async function serveMcpRequest(request: Request, authInfo: AuthInfo) {
  if (await isLegacyRequest(request)) return legacyHandler(request, authInfo);
  return handler.fetch(request, { authInfo });
}
