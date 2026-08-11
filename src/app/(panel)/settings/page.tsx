import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUserOrRedirect } from "@/server/auth/require-user";
import { SITE_CATEGORIES } from "@/server/sites/site-meta";
import { getSystemStatus } from "@/server/network/system-status";
import { PanelSettingsForm } from "@/components/settings/panel-settings-form";
import { getUpdateState } from "@/server/updates/panel-updater";
import { getPublicNotificationSettings } from "@/server/notifications/store";
import { getMonitoringSettings } from "@/server/monitoring/store";
import { getSecuritySettings } from "@/server/settings/store";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const session = await requireUserOrRedirect({ allowDuringUpdate: true });
  if (session.user.panelRole !== "super-admin") redirect("/sites");

  // Reaching this page means the readiness gate in (panel)/layout.tsx already
  // passed, so the base domain is configured and its wildcard resolves here.
  // The card below is therefore a read-only status view; reconfiguring the base
  // domain happens on the dedicated /setup screen.
  const status = await getSystemStatus();
  const [update, notifications, monitoring, security] = await Promise.all([
    getUpdateState(),
    getPublicNotificationSettings(),
    getMonitoringSettings(),
    getSecuritySettings(),
  ]);

  return (
    <PanelSettingsForm
      baseDomain={status.baseDomain}
      addressMode={status.addressMode}
      serverIp={status.serverIp}
      wildcardDomain={status.wildcardDomain}
      pointed={status.pointed}
      categories={SITE_CATEGORIES}
      update={update}
      notifications={notifications}
      monitoring={monitoring}
      security={security}
    />
  );
}
