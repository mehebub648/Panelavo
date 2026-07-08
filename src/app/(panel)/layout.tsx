import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { requireUser } from "@/server/auth/require-user";

export const dynamic = "force-dynamic";

export default async function PanelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  try {
    const session = await requireUser();
    return <AppShell user={session.user}>{children}</AppShell>;
  } catch {
    redirect("/login?reason=session-expired");
  }
}
