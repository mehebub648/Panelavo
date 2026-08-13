import { OAuthErrorCode } from "@modelcontextprotocol/server";
import type { NextRequest } from "next/server";
import { AppError } from "@/server/cloudpanel/errors";
import {
  McpOAuthError,
  mcpOAuthErrorResponse,
  registerMcpOAuthClient,
} from "@/server/mcp/oauth";
import { getMcpPublicUrls } from "@/server/mcp/public-url";
import { clientKey, rateLimit } from "@/server/security/request";

export const runtime = "nodejs";

function routeError(error: unknown) {
  if (error instanceof AppError && error.status === 429)
    return mcpOAuthErrorResponse(
      new McpOAuthError(OAuthErrorCode.TooManyRequests, error.message, 429),
    );
  return mcpOAuthErrorResponse(error);
}

export async function POST(request: NextRequest) {
  try {
    getMcpPublicUrls(request);
    rateLimit(`mcp-register:${clientKey(request)}`, 30, 60 * 60_000);
    const contentType =
      request.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json"))
      throw new McpOAuthError(
        OAuthErrorCode.InvalidClientMetadata,
        "Client registration must use JSON.",
        415,
      );
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > 32 * 1024)
      throw new McpOAuthError(
        OAuthErrorCode.InvalidClientMetadata,
        "Client registration is too large.",
        413,
      );
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > 32 * 1024)
      throw new McpOAuthError(
        OAuthErrorCode.InvalidClientMetadata,
        "Client registration is too large.",
        413,
      );
    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      throw new McpOAuthError(
        OAuthErrorCode.InvalidClientMetadata,
        "Client registration must contain valid JSON.",
      );
    }
    return Response.json(await registerMcpOAuthClient(input), {
      status: 201,
      headers: {
        "cache-control": "no-store",
        pragma: "no-cache",
      },
    });
  } catch (error) {
    return routeError(error);
  }
}
