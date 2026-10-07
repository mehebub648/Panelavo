import type { Metadata } from "next";
import { McpSetupGuide } from "@/components/mcp/mcp-setup-guide";
import { requireUserOrRedirect } from "@/server/auth/require-user";
import { listMcpConnections } from "@/server/mcp/oauth";

export const metadata: Metadata = { title: "AI access" };
export const dynamic = "force-dynamic";

export default async function AiAccessPage() {
  const session = await requireUserOrRedirect({ allowDuringUpdate: true });
  const connections = await listMcpConnections(
    session.user.id,
    session.user.username,
  );

  return (
    <McpSetupGuide
      user={session.user}
      initialConnections={connections}
    />
  );
}
