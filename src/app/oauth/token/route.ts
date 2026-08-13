import { OAuthErrorCode } from "@modelcontextprotocol/server";
import type { NextRequest } from "next/server";
import { AppError } from "@/server/cloudpanel/errors";
import {
  McpOAuthError,
  exchangeMcpOAuthToken,
  mcpOAuthErrorResponse,
  parseMcpOAuthForm,
} from "@/server/mcp/oauth";
import { getMcpPublicUrls } from "@/server/mcp/public-url";
import { clientKey, rateLimit } from "@/server/security/request";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const urls = getMcpPublicUrls(request);
    if (request.headers.has("authorization"))
      throw new McpOAuthError(
        OAuthErrorCode.InvalidClient,
        "This public OAuth client must not use HTTP client authentication.",
        401,
      );
    rateLimit(`mcp-token:${clientKey(request)}`, 120, 15 * 60_000);
    return Response.json(
      await exchangeMcpOAuthToken(await parseMcpOAuthForm(request), urls),
      {
        headers: {
          "cache-control": "no-store",
          pragma: "no-cache",
        },
      },
    );
  } catch (error) {
    if (error instanceof AppError && error.status === 429)
      return mcpOAuthErrorResponse(
        new McpOAuthError(OAuthErrorCode.TooManyRequests, error.message, 429),
      );
    return mcpOAuthErrorResponse(error);
  }
}
