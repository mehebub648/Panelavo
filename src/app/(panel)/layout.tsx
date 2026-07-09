import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { requireUserOrRedirect } from "@/server/auth/require-user";
import { getSystemStatus } from "@/server/network/system-status";

export const dynamic = "force-dynamic";

export default async function PanelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireUserOrRedirect();
  const status = await getSystemStatus();
  if (!status.ready) redirect("/setup");
  return <AppShell user={session.user}>{children}</AppShell>;
}
