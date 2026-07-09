import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUserOrRedirect } from "@/server/auth/require-user";
import { getSystemStatus } from "@/server/network/system-status";
import { SetupView } from "@/components/setup/setup-view";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Set up" };

// Onboarding gate. Lives outside the (panel) route group so it is never itself
// gated by the readiness check in (panel)/layout.tsx.
export default async function SetupPage() {
  const session = await requireUserOrRedirect();
  const status = await getSystemStatus({ refresh: true });
  if (status.ready) redirect("/sites");
  return (
    <SetupView
      status={status}
      isSuperAdmin={session.user.panelRole === "super-admin"}
    />
  );
}
