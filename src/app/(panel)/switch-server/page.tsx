import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireFleetSuperAdminOrRedirect } from "@/server/fleet/auth";
import { ServerSwitcher } from "@/components/settings/server-switcher";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Switch server" };

export default async function SwitchServerPage() {
  if (!(await requireFleetSuperAdminOrRedirect({ allowDuringUpdate: true })))
    notFound();
  return <ServerSwitcher />;
}
