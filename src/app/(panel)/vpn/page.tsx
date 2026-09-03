import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { VpnManager } from "@/components/vpn/vpn-manager";
import { requireUserOrRedirect } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "WireGuard VPN" };

export default async function VpnPage() {
  const session = await requireUserOrRedirect({ allowDuringUpdate: true });
  if (session.user.panelRole !== "super-admin") notFound();
  const state = await getCloudPanelClient().getVpnState(
    session.record.cloudPanel,
  );
  return <VpnManager initialState={state} />;
}
