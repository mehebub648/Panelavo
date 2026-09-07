import { notFound } from "next/navigation";
import { FleetServerWorkspace } from "@/components/fleet/fleet-server-workspace";
import { requireFleetSuperAdminOrRedirect } from "@/server/fleet/auth";
import { getFleetPublicState } from "@/server/fleet/service";
import { fleetSection } from "@/lib/fleet-navigation";
import { SiteList } from "@/components/sites/site-list";

export const dynamic = "force-dynamic";
export default async function FleetServerPage({
  params,
  searchParams,
}: {
  params: Promise<{ serverId: string }>;
  searchParams: Promise<{ tab?: string }>;
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
  if (!node) notFound();
  const tab = fleetSection((await searchParams).tab);
  const nickname = state.nodes.find((item) => item.id === serverId)?.nickname;
  if (tab === "websites")
    return (
      <SiteList
        key={serverId}
        user={session.user}
        apiBase={`/api/fleet/servers/${serverId}/proxy`}
        routeBase={`/servers/${serverId}`}
        listHref={`/servers/${serverId}?tab=websites`}
      />
    );
  return (
    <FleetServerWorkspace
      key={`${serverId}:${tab}`}
      serverId={serverId}
      label={nickname || node.label}
      user={session.user}
      tab={tab}
    />
  );
}
