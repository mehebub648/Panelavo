import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUserOrRedirect } from "@/server/auth/require-user";
import { getPanelSettings } from "@/server/settings/store";
import { SITE_CATEGORIES } from "@/server/sites/site-meta";
import {
  resolveDnsStatus,
  systemWildcardDomain,
  systemWildcardProbe,
} from "@/server/network/dns";
import { getServerPublicIp } from "@/server/network/server-ip";
import { PanelSettingsForm } from "@/components/settings/panel-settings-form";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const session = await requireUserOrRedirect();
  if (session.user.panelRole !== "super-admin") redirect("/sites");
  const settings = await getPanelSettings();
  const serverIp = await getServerPublicIp();
  const probeName = settings.baseDomain
    ? systemWildcardProbe(serverIp, settings.baseDomain)
    : "";
  const [dns] = probeName ? await resolveDnsStatus([probeName], serverIp) : [null];
  return (
    <PanelSettingsForm
      initialSettings={settings}
      initialDns={dns}
      wildcardDomain={
        settings.baseDomain ? systemWildcardDomain(serverIp, settings.baseDomain) : ""
      }
      serverIp={serverIp}
      categories={SITE_CATEGORIES}
    />
  );
}
