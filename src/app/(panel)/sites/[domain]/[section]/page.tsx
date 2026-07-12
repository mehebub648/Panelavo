import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { requireUserOrRedirect } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { SiteSettings } from "@/components/sites/site-settings";
import { DomainsManager } from "@/components/sites/domains-manager";
import { SiteSectionManager } from "@/components/sites/site-section-manager";
import { GitManager } from "@/components/sites/git-manager";
import { ActionsManager } from "@/components/sites/actions-manager";
import { EnvManager, type EnvSectionData } from "@/components/sites/env-manager";
import { TerminalManager, type TerminalData } from "@/components/sites/terminal-manager";
import { BackupsManager, type BackupsData } from "@/components/sites/backups-manager";
import { getServerPublicIp } from "@/server/network/server-ip";
import type { OperationsData } from "@/types/operations";

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
  terminal: "Terminal",
  backups: "Backups",
  "cron-jobs": "Cron Jobs",
  logs: "Logs",
};
const descriptions: Record<string, string> = {
  settings: "Runtime, document root, and core website configuration.",
  domains: "System domain, your own domains, DNS, and SSL for this website.",
  actions: "Deployment readiness, lifecycle controls, scheduled jobs, and logs.",
  vhost: "Review and update the NGINX configuration for this website.",
  databases: "Create databases and manage their associated users.",
  certificates: "Issue, renew, and review TLS certificates.",
  security: "Control blocked traffic, authentication, proxy access, SSH, and FTP.",
  users: "Manage shell and file-transfer access to this website.",
  "file-manager": "Browse and organize files in the website root.",
  git: "Manage repository status, remotes, branches, commits, pulls, and pushes.",
  terminal: "Run commands as the website's system user, in the browser or over SSH.",
  backups: "Snapshot and restore this website's files and databases.",
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
  const session = await requireUserOrRedirect({ allowDuringUpdate: true });
  const cloudPanel = getCloudPanelClient();
  const canWrite =
    session.user.canCreateSites || session.user.panelRole === "admin";
  if (section === "settings") {
    const sites = await cloudPanel.listSites(session.record.cloudPanel);
    const site = sites.find((item) => item.domain === domain);
    if (!site) notFound();
    const siteMeta = await import("@/server/sites/site-meta").then(m => m.getSiteMeta(domain));
    const mergedSite = siteMeta ? { ...site, meta: siteMeta } : site;
    // Environment values are secrets: they are only loaded and rendered for
    // users who can already manage this website's files.
    const env = canWrite
      ? await cloudPanel
          .getSiteSection(session.record.cloudPanel, domain, "env")
          .catch(() => null)
      : null;
    return (
      <div className="w-full space-y-5">
        <SiteSettings initialSite={mergedSite} user={session.user} />
        {env ? (
          <EnvManager
            domain={domain}
            initialData={env as EnvSectionData}
            canWrite={canWrite}
          />
        ) : null}
      </div>
    );
  }
  if (section === "terminal") {
    const [terminal, host] = await Promise.all([
      cloudPanel.getSiteSection(session.record.cloudPanel, domain, "terminal"),
      getServerPublicIp(),
    ]);
    const terminalData = { ...(terminal as Omit<TerminalData, "host">), host };
    return (
      <div className="w-full space-y-5">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-ink">Terminal</h2>
          <p className="mt-1 text-sm text-slate-500">{descriptions.terminal}</p>
        </div>
        <TerminalManager
          domain={domain}
          initialData={terminalData}
          canWrite={canWrite}
        />
      </div>
    );
  }
  if (section === "backups") {
    const backups = await cloudPanel.getSiteSection(
      session.record.cloudPanel,
      domain,
      "backups",
    );
    return (
      <div className="w-full space-y-5">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-ink">Backups</h2>
          <p className="mt-1 text-sm text-slate-500">{descriptions.backups}</p>
        </div>
        <BackupsManager
          domain={domain}
          initialData={backups as BackupsData}
          canWrite={canWrite}
        />
      </div>
    );
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
    const [actionsResult, cronJobsResult, logsResult] = await Promise.allSettled([
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
        {actionsResult.status === "fulfilled" ? (
          <ActionsManager
            domain={domain}
            initialData={actionsResult.value as OperationsData}
          />
        ) : (
          <SectionUnavailable name="deployment checks and actions" />
        )}
        <SectionBlock title="Cron jobs" description={descriptions["cron-jobs"]}>
          {cronJobsResult.status === "fulfilled" ? (
            <SiteSectionManager
              domain={domain}
              section="cron-jobs"
              initialData={(cronJobsResult.value ?? {}) as Record<string, unknown>}
            />
          ) : (
            <SectionUnavailable name="scheduled jobs" />
          )}
        </SectionBlock>
        <SectionBlock title="Logs" description={descriptions.logs}>
          {logsResult.status === "fulfilled" ? (
            <SiteSectionManager
              domain={domain}
              section="logs"
              initialData={(logsResult.value ?? {}) as Record<string, unknown>}
            />
          ) : (
            <SectionUnavailable name="website logs" />
          )}
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

function SectionUnavailable({ name }: { name: string }) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-5 text-sm text-amber-900 shadow-card">
      <p className="font-bold">Could not load {name}</p>
      <p className="mt-1 text-amber-800">
        The other Operations sections remain available. Refresh this page after
        checking the CloudPanel service.
      </p>
    </div>
  );
}
