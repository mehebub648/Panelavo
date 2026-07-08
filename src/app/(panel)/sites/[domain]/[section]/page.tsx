import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { SiteSettings } from "@/components/sites/site-settings";
import { SiteSectionManager } from "@/components/sites/site-section-manager";

const titles: Record<string, string> = {
  settings: "Settings",
  vhost: "Vhost",
  databases: "Databases",
  certificates: "SSL/TLS",
  security: "Security",
  users: "SSH/FTP",
  "file-manager": "File Manager",
  "cron-jobs": "Cron Jobs",
  logs: "Logs",
};

export default async function SiteSectionPage({
  params,
}: {
  params: Promise<{ domain: string; section: string }>;
}) {
  const { domain: encodedDomain, section } = await params;
  if (!titles[section]) notFound();
  const domain = decodeURIComponent(encodedDomain);
  const session = await requireUser();
  if (section === "settings") {
    const sites = await getCloudPanelClient().listSites(session.record.cloudPanel);
    const site = sites.find((item) => item.domain === domain);
    if (!site) notFound();
    return <SiteSettings initialSite={site} user={session.user} />;
  }
  const data = await getCloudPanelClient().getSiteSection(
    session.record.cloudPanel,
    domain,
    section,
  );
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-ink">{titles[section]}</h1>
        <p className="mt-1 text-sm text-slate-500">{domain}</p>
      </div>
      <SiteSectionManager domain={domain} section={section} initialData={(data ?? {}) as Record<string, unknown>} />
    </div>
  );
}
