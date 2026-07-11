import type { Metadata } from "next";
import { SiteList } from "@/components/sites/site-list";
import { requireUserOrRedirect } from "@/server/auth/require-user";

export const metadata: Metadata = { title: "Websites" };
export default async function SitesPage() {
  const session = await requireUserOrRedirect({ allowDuringUpdate: true });
  return <SiteList user={session.user} />;
}
