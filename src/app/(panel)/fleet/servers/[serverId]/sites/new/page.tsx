import { notFound } from "next/navigation";
import { CreateSiteForm } from "@/components/sites/create-site-form";
import { requireFleetSuperAdminOrRedirect } from "@/server/fleet/auth";
import { getFleetPublicState } from "@/server/fleet/service";

export const dynamic = "force-dynamic";
export default async function FleetCreateSitePage({
  params,
}: {
  params: Promise<{ serverId: string }>;
}) {
  const session = await requireFleetSuperAdminOrRedirect();
  if (!session) notFound();
  const { serverId } = await params;
  const state = await getFleetPublicState();
  if (
    serverId !== "local" &&
    (state.mode !== "hub" || !state.nodes.some((item) => item.id === serverId))
  )
    notFound();
  return (
    <CreateSiteForm
      apiBase={`/api/fleet/servers/${serverId}/proxy`}
      routeBase={`/fleet/servers/${serverId}`}
    />
  );
}
