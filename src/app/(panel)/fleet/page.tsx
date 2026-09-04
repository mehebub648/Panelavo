import { notFound } from "next/navigation";
import { FleetManager } from "@/components/fleet/fleet-manager";
import { requireFleetSuperAdminOrRedirect } from "@/server/fleet/auth";
import { getFleetPublicState } from "@/server/fleet/service";

export const dynamic = "force-dynamic";
export default async function FleetPage() {
  const session = await requireFleetSuperAdminOrRedirect({
    allowDuringUpdate: true,
  });
  if (!session) notFound();
  return <FleetManager initialState={await getFleetPublicState()} />;
}
