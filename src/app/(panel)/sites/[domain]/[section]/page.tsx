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
const descriptions: Record<string, string> = {
  settings: "Runtime, document root, and core website configuration.",
  vhost: "Review and update the NGINX configuration for this website.",
  databases: "Create databases and manage their associated users.",
  certificates: "Issue, renew, and review TLS certificates.",
  security: "Control blocked traffic, authentication, and proxy access.",
  users: "Manage shell and file-transfer access to this website.",
  "file-manager": "Browse and organize files in the website root.",
  "cron-jobs": "Create and review recurring background commands.",
  logs: "Inspect available log files and clear them when needed.",
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
    const sites = await getCloudPanelClient().listSites(
      session.record.cloudPanel,
    );
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
    <div className="mx-auto max-w-6xl space-y-5">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          {titles[section]}
        </h2>
        <p className="mt-1 text-sm text-slate-500">{descriptions[section]}</p>
      </div>
      <SiteSectionManager
        domain={domain}
        section={section}
        initialData={(data ?? {}) as Record<string, unknown>}
      />
    </div>
  );
}
