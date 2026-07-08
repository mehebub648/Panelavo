import { redirect } from "next/navigation";

export default async function SiteSettingsPage({
  params,
}: {
  params: Promise<{ domain: string }>;
}) {
  const domain = decodeURIComponent((await params).domain);
  redirect(`/sites/${encodeURIComponent(domain)}/settings`);
}
