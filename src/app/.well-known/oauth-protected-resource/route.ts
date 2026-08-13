import {
  getMcpPublicUrls,
  mcpProtectedResourceMetadata,
} from "@/server/mcp/public-url";

export const runtime = "nodejs";

export function GET(request: Request) {
  try {
    return Response.json(
      mcpProtectedResourceMetadata(getMcpPublicUrls(request)),
      { headers: { "cache-control": "public, max-age=300" } },
    );
  } catch {
    return Response.json(
      {
        error: "invalid_request",
        error_description: "Invalid public MCP address.",
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
}
