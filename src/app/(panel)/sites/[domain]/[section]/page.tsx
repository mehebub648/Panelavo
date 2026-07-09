import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { SiteSettings } from "@/components/sites/site-settings";
import { DomainsManager } from "@/components/sites/domains-manager";
import { SiteSectionManager } from "@/components/sites/site-section-manager";
import { GitManager } from "@/components/sites/git-manager";
import { ActionsManager } from "@/components/sites/actions-manager";

const titles: Record<string, string> = {
  settings: "Settings",
  domains: "Domains",
  actions: "Operations",
  vhost: "Vhost",
  databases: "Databases",
  certificates: "SSL/TLS",
  security: "Security",
  users: "SSH/FTP",
  "file-manager": "File Manager",
  git: "Git",
  "cron-jobs": "Cron Jobs",
  logs: "Logs",
};
const descriptions: Record<string, string> = {
  settings: "Runtime, document root, and core website configuration.",
  domains: "System domain, your own domains, DNS, and SSL for this website.",
  actions: "Maintenance commands, scheduled jobs, and logs.",
  vhost: "Review and update the NGINX configuration for this website.",
  databases: "Create databases and manage their associated users.",
  certificates: "Issue, renew, and review TLS certificates.",
  security: "Control blocked traffic, authentication, proxy access, SSH, and FTP.",
  users: "Manage shell and file-transfer access to this website.",
  "file-manager": "Browse and organize files in the website root.",
  git: "Manage repository status, remotes, branches, commits, pulls, and pushes.",
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
  const cloudPanel = getCloudPanelClient();
  if (section === "settings") {
    const sites = await cloudPanel.listSites(session.record.cloudPanel);
    const site = sites.find((item) => item.domain === domain);
    if (!site) notFound();
    return <SiteSettings initialSite={site} user={session.user} />;
  }
  if (section === "domains") {
    const certificates = await cloudPanel.getSiteSection(
      session.record.cloudPanel,
      domain,
      "certificates",
    );
    return (
      <div className="w-full space-y-5">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-ink">Domains</h2>
          <p className="mt-1 text-sm text-slate-500">{descriptions.domains}</p>
        </div>
        <DomainsManager
          domain={domain}
          canWrite={
            session.user.canCreateSites || session.user.panelRole === "admin"
          }
        />
        <SectionBlock
          title="Installed certificates"
          description={descriptions.certificates}
        >
          <SiteSectionManager
            domain={domain}
            section="certificates"
            initialData={(certificates ?? {}) as Record<string, unknown>}
          />
        </SectionBlock>
      </div>
    );
  }
  if (section === "actions") {
    const [actions, cronJobs, logs] = await Promise.all([
      cloudPanel.getSiteSection(session.record.cloudPanel, domain, "actions"),
      cloudPanel.getSiteSection(session.record.cloudPanel, domain, "cron-jobs"),
      cloudPanel.getSiteSection(session.record.cloudPanel, domain, "logs"),
    ]);
    return (
      <div className="w-full space-y-7">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-ink">
            Operations
          </h2>
          <p className="mt-1 text-sm text-slate-500">{descriptions.actions}</p>
        </div>
        <ActionsManager
          domain={domain}
          initialData={(actions ?? {}) as Parameters<typeof ActionsManager>[0]["initialData"]}
          canRunDocker={["super-admin", "manager"].includes(session.user.panelRole ?? "")}
        />
        <SectionBlock title="Cron jobs" description={descriptions["cron-jobs"]}>
          <SiteSectionManager
            domain={domain}
            section="cron-jobs"
            initialData={(cronJobs ?? {}) as Record<string, unknown>}
          />
        </SectionBlock>
        <SectionBlock title="Logs" description={descriptions.logs}>
          <SiteSectionManager
            domain={domain}
            section="logs"
            initialData={(logs ?? {}) as Record<string, unknown>}
          />
        </SectionBlock>
      </div>
    );
  }
  if (section === "security") {
    const [security, users] = await Promise.all([
      cloudPanel.getSiteSection(session.record.cloudPanel, domain, "security"),
      cloudPanel.getSiteSection(session.record.cloudPanel, domain, "users"),
    ]);
    return (
      <div className="w-full space-y-7">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-ink">
            Security
          </h2>
          <p className="mt-1 text-sm text-slate-500">{descriptions.security}</p>
        </div>
        <SiteSectionManager
          domain={domain}
          section="security"
          initialData={(security ?? {}) as Record<string, unknown>}
        />
        <SectionBlock title="SSH/FTP access" description={descriptions.users}>
          <SiteSectionManager
            domain={domain}
            section="users"
            initialData={(users ?? {}) as Record<string, unknown>}
          />
        </SectionBlock>
      </div>
    );
  }
  const data = await cloudPanel.getSiteSection(
    session.record.cloudPanel,
    domain,
    section,
  );
  if (section === "git") return <div className="w-full space-y-5"><div><h2 className="text-2xl font-bold tracking-tight text-ink">Git</h2><p className="mt-1 text-sm text-slate-500">{descriptions.git}</p></div><GitManager domain={domain} initialData={data as Parameters<typeof GitManager>[0]["initialData"]} /></div>;
  return (
    <div className="w-full space-y-5">
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

function SectionBlock({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xl font-bold tracking-tight text-ink">{title}</h3>
        <p className="mt-1 text-sm text-slate-500">{description}</p>
      </div>
      {children}
    </div>
  );
}
