import { notFound } from "next/navigation";
import { ServerInformationView } from "@/components/server/server-information-view";
import { requireUserOrRedirect } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { completeServerInformation } from "@/server/network/server-information";

export const dynamic = "force-dynamic";

export default async function InformationPage() {
  const session = await requireUserOrRedirect({ allowDuringUpdate: true });
  if (!["super-admin", "manager"].includes(session.user.panelRole ?? ""))
    notFound();
  const info = completeServerInformation(
    await getCloudPanelClient().getServerInfo(session.record.cloudPanel),
  );

  return (
    <div className="w-full space-y-5">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          Information
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Network, hardware, operating system, maintenance, and installed
          software on this server.
        </p>
      </div>
      <ServerInformationView info={info} />
    </div>
  );
}
