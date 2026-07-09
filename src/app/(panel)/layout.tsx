import { AppShell } from "@/components/layout/app-shell";
import { requireUserOrRedirect } from "@/server/auth/require-user";

export const dynamic = "force-dynamic";

export default async function PanelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireUserOrRedirect();
  return <AppShell user={session.user}>{children}</AppShell>;
}
