import { notFound, redirect } from "next/navigation";
import { requireFleetSuperAdminOrRedirect } from "@/server/fleet/auth";

export default async function LegacyFleetPage() {
  if (!(await requireFleetSuperAdminOrRedirect())) notFound();
  redirect("/settings#connected-servers");
}
