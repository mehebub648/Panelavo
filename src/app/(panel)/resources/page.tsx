import { notFound } from "next/navigation";
import { requireUserOrRedirect } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { getResourceHistory } from "@/server/system/resource-history";
import { ResourcesView } from "@/components/server/resources-view";

export const dynamic = "force-dynamic";

export default async function ResourcesPage() {
  const session = await requireUserOrRedirect();
  if (!["super-admin", "manager"].includes(session.user.panelRole ?? "")) notFound();
  const [resources, history] = await Promise.all([
    getCloudPanelClient().getServerResources(session.record.cloudPanel),
    getResourceHistory(),
  ]);
  return <ResourcesView initialData={resources} initialHistory={history} />;
}
