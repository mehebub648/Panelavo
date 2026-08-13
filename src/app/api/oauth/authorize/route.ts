import { OAuthErrorCode } from "@modelcontextprotocol/server";
import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import {
  McpOAuthError,
  completeMcpAuthorization,
  mcpOAuthErrorResponse,
  parseMcpOAuthForm,
} from "@/server/mcp/oauth";
import { getMcpPublicUrls } from "@/server/mcp/public-url";
import { rateLimit } from "@/server/security/request";

export const runtime = "nodejs";

function assertSameOrigin(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site && !["same-origin", "none"].includes(site))
    throw new McpOAuthError(
      OAuthErrorCode.AccessDenied,
      "Cross-origin approval requests are not allowed.",
      403,
    );
  const origin = request.headers.get("origin");
  const host = request.headers.get("host")?.trim();
  if (!origin || !host) return;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new McpOAuthError(
      OAuthErrorCode.AccessDenied,
      "Cross-origin approval requests are not allowed.",
      403,
    );
  }
  if (originHost.toLowerCase() !== host.toLowerCase())
    throw new McpOAuthError(
      OAuthErrorCode.AccessDenied,
      "Cross-origin approval requests are not allowed.",
      403,
    );
}

function one(params: URLSearchParams, name: string) {
  const values = params.getAll(name);
  if (values.length !== 1 || !values[0])
    throw new McpOAuthError(
      OAuthErrorCode.InvalidRequest,
      `The ${name} field is required.`,
    );
  return values[0];
}

export async function POST(request: NextRequest) {
  try {
    getMcpPublicUrls(request);
    assertSameOrigin(request);
    const form = await parseMcpOAuthForm(request);
    const decision = one(form, "decision");
    if (!(["approve", "deny"] as string[]).includes(decision))
      throw new McpOAuthError(
        OAuthErrorCode.InvalidRequest,
        "Choose whether to allow or deny the connection.",
      );
    const { user } = await requireUser();
    rateLimit(`mcp-consent:${user.id}`, 30, 15 * 60_000);
    const location = await completeMcpAuthorization(
      one(form, "consent_token"),
      decision as "approve" | "deny",
      user,
    );
    return new Response(null, {
      status: 303,
      headers: {
        location,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return mcpOAuthErrorResponse(error);
  }
}
