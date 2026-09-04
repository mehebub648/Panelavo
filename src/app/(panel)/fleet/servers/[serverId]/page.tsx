import { notFound } from "next/navigation";
import { FleetServerWorkspace } from "@/components/fleet/fleet-server-workspace";
import { requireFleetSuperAdminOrRedirect } from "@/server/fleet/auth";
import { getFleetPublicState } from "@/server/fleet/service";

export const dynamic = "force-dynamic";
export default async function FleetServerPage({
  params,
}: {
  params: Promise<{ serverId: string }>;
}) {
  const session = await requireFleetSuperAdminOrRedirect({
    allowDuringUpdate: true,
  });
  if (!session) notFound();
  const { serverId } = await params;
  const state = await getFleetPublicState();
  const node =
    serverId === "local"
      ? { label: "Local server" }
      : state.nodes.find((item) => item.id === serverId)?.node;
  if (!node || (serverId !== "local" && state.mode !== "hub")) notFound();
  return <FleetServerWorkspace serverId={serverId} label={node.label} />;
}
