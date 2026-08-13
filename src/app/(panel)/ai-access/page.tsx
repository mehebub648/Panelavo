import type { Metadata } from "next";
import { headers } from "next/headers";
import { McpSetupGuide } from "@/components/mcp/mcp-setup-guide";
import { requireUserOrRedirect } from "@/server/auth/require-user";
import { listMcpConnections } from "@/server/mcp/oauth";
import { getMcpPublicUrlsFromHeaders } from "@/server/mcp/public-url";

export const metadata: Metadata = { title: "AI access" };
export const dynamic = "force-dynamic";

async function mcpEndpoint() {
  const incoming = await headers();
  return getMcpPublicUrlsFromHeaders(new Headers(incoming)).resource;
}

export default async function AiAccessPage() {
  const session = await requireUserOrRedirect({ allowDuringUpdate: true });
  const [endpoint, connections] = await Promise.all([
    mcpEndpoint(),
    listMcpConnections(session.user.id, session.user.username),
  ]);

  return (
    <McpSetupGuide
      user={session.user}
      endpoint={endpoint}
      initialConnections={connections}
    />
  );
}
