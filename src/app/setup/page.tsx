import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUserOrRedirect } from "@/server/auth/require-user";
import { getSystemStatus } from "@/server/network/system-status";
import { SetupView } from "@/components/setup/setup-view";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Set up" };

// Onboarding gate. Lives outside the (panel) route group so it is never itself
// gated by the readiness check in (panel)/layout.tsx.
//
// `?reconfigure=1` lets a super admin reopen this screen after setup is already
// complete (from Settings → Change base domain); without it, a ready panel
// bounces straight back to the app.
export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ reconfigure?: string }>;
}) {
  const session = await requireUserOrRedirect();
  const { reconfigure } = await searchParams;
  const isSuperAdmin = session.user.panelRole === "super-admin";
  const reconfiguring = reconfigure === "1" && isSuperAdmin;

  const status = await getSystemStatus({ refresh: true });
  if (status.ready && !reconfiguring) redirect("/sites");

  return (
    <SetupView
      status={status}
      isSuperAdmin={isSuperAdmin}
      reconfiguring={reconfiguring}
    />
  );
}
