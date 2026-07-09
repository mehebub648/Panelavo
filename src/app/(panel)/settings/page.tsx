import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUserOrRedirect } from "@/server/auth/require-user";
import { getPanelSettings, panelZoneFor } from "@/server/settings/store";
import { SITE_CATEGORIES } from "@/server/sites/site-meta";
import { getServerPublicIp } from "@/server/network/server-ip";
import { PanelSettingsForm } from "@/components/settings/panel-settings-form";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const session = await requireUserOrRedirect();
  if (session.user.panelRole !== "super-admin") redirect("/sites");
  const settings = await getPanelSettings();
  const [zone, serverIp] = await Promise.all([
    settings.baseDomain && settings.cloudflare.configured
      ? panelZoneFor(settings.baseDomain)
      : Promise.resolve(null),
    getServerPublicIp(),
  ]);
  return (
    <PanelSettingsForm
      initialSettings={settings}
      initialZone={zone}
      serverIp={serverIp}
      categories={SITE_CATEGORIES}
    />
  );
}
