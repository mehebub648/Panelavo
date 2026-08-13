import type { NextRequest } from "next/server";
import { authenticateMcpBearer } from "@/server/mcp/oauth";
import {
  serveMcpRequest,
  validateMcpRequestOrigin,
} from "@/server/mcp/handler";
import { AppError } from "@/server/cloudpanel/errors";
import { rateLimit } from "@/server/security/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1800;

async function handle(request: NextRequest) {
  let rejected: Response | undefined;
  try {
    rejected = validateMcpRequestOrigin(request);
  } catch {
    return new Response("Invalid public MCP address.", { status: 400 });
  }
  if (rejected) return rejected;
  const authenticated = await authenticateMcpBearer(request);
  if (authenticated instanceof Response) return authenticated;
  try {
    rateLimit(
      `mcp:${authenticated.actor.credentialId ?? authenticated.authInfo.clientId}`,
      300,
      60_000,
    );
  } catch (error) {
    if (error instanceof AppError && error.status === 429)
      return Response.json(
        { error: "rate_limited", message: error.message },
        {
          status: 429,
          headers: { "cache-control": "no-store", "retry-after": "60" },
        },
      );
    throw error;
  }
  return serveMcpRequest(request, authenticated.authInfo);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: "GET, POST, DELETE, OPTIONS",
      "Cache-Control": "no-store",
    },
  });
}
