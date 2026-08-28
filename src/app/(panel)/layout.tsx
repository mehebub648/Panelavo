import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { requireUserOrRedirect } from "@/server/auth/require-user";
import { getSystemStatus } from "@/server/network/system-status";
import { UpdateMaintenanceGuard } from "@/components/settings/update-maintenance-guard";
import { isPanelUpdateRunning } from "@/server/updates/panel-updater";

export const dynamic = "force-dynamic";

export default async function PanelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireUserOrRedirect({ allowDuringUpdate: true });
  const updateRunning = await isPanelUpdateRunning();
  const status = await getSystemStatus();
  if (!status.ready) redirect("/setup");
  return <><UpdateMaintenanceGuard initialRunning={updateRunning} /><AppShell user={session.user}>{children}</AppShell></>;
}
