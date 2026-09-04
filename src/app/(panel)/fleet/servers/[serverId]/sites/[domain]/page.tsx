import { redirect } from "next/navigation";
export default async function FleetSitePage({
  params,
}: {
  params: Promise<{ serverId: string; domain: string }>;
}) {
  const { serverId, domain } = await params;
  redirect(`/fleet/servers/${serverId}/sites/${domain}/settings`);
}
