import { redirect } from "next/navigation";

export default async function ServerSitesPage({
  params,
  searchParams,
}: {
  params: Promise<{ serverId: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const { serverId } = await params;
  const { created } = await searchParams;
  redirect(
    `/servers/${encodeURIComponent(serverId)}?tab=websites${created ? `&created=${encodeURIComponent(created)}` : ""}`,
  );
}
