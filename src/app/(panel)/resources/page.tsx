import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { ResourcesView } from "@/components/server/resources-view";

export const dynamic = "force-dynamic";

export default async function ResourcesPage() {
  const session = await requireUser();
  if (!["super-admin", "manager"].includes(session.user.panelRole ?? "")) notFound();
  const resources = await getCloudPanelClient().getServerResources(
    session.record.cloudPanel,
  );
  return <ResourcesView initialData={resources} />;
}
