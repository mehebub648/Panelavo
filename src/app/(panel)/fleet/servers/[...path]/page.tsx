import { notFound, redirect } from "next/navigation";
import { requireFleetSuperAdminOrRedirect } from "@/server/fleet/auth";

export default async function LegacyServerPage({
  params,
}: {
  params: Promise<{ path: string[] }>;
}) {
  if (!(await requireFleetSuperAdminOrRedirect())) notFound();
  const { path } = await params;
  redirect(`/servers/${path.map(encodeURIComponent).join("/")}`);
}
