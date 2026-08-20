import { notFound } from "next/navigation";
import { requireUserOrRedirect } from "@/server/auth/require-user";
import { getResourceHistory } from "@/server/system/resource-history";
import { ResourcesView } from "@/components/server/resources-view";

export const dynamic = "force-dynamic";

export default async function ResourcesPage() {
  const session = await requireUserOrRedirect({ allowDuringUpdate: true });
  if (!["super-admin", "manager"].includes(session.user.panelRole ?? "")) notFound();
  const history = await getResourceHistory();
  return (
    <ResourcesView
      initialData={null}
      initialHistory={history}
      canReclaimStorage={session.user.panelRole === "super-admin"}
    />
  );
}
