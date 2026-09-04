import { notFound } from "next/navigation";
import { ActionsManager } from "@/components/sites/actions-manager";
import {
  BackupsManager,
  type BackupsData,
} from "@/components/sites/backups-manager";
import { DomainsManager } from "@/components/sites/domains-manager";
import {
  EnvManager,
  type EnvSectionData,
} from "@/components/sites/env-manager";
import { GitManager } from "@/components/sites/git-manager";
import { LinkedServices } from "@/components/sites/linked-services";
import { SiteSectionManager } from "@/components/sites/site-section-manager";
import { SiteSettings } from "@/components/sites/site-settings";
import {
  TerminalManager,
  type TerminalData,
} from "@/components/sites/terminal-manager";
import { SERVICE_SECTIONS } from "@/components/sites/site-sections";
import { panelActorFromSession } from "@/server/auth/site-access";
import { requireFleetSuperAdminOrRedirect } from "@/server/fleet/auth";
import { dispatchFleetAction } from "@/server/fleet/service";
import type { CloudPanelSite, ServerInfo } from "@/types/cloudpanel";
import type { OperationsData } from "@/types/operations";

const sections = new Set([
  "settings",
  "domains",
  "actions",
  "vhost",
  "databases",
  "certificates",
  "security",
  "users",
  "file-manager",
  "git",
  "env",
  "terminal",
  "backups",
  "cron-jobs",
  "logs",
]);
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
  env: "Environment",
  terminal: "Terminal",
  backups: "Backups",
  "cron-jobs": "Cron Jobs",
  logs: "Logs",
};

export default async function FleetSiteSectionPage({
  params,
}: {
  params: Promise<{ serverId: string; domain: string; section: string }>;
}) {
  const session = await requireFleetSuperAdminOrRedirect({
    allowDuringUpdate: true,
  });
  if (!session) notFound();
  const { serverId, domain: encoded, section } = await params;
  if (!sections.has(section)) notFound();
  const domain = decodeURIComponent(encoded);
  const actor = panelActorFromSession(session);
  const site = (await dispatchFleetAction(
    serverId,
    "site.get",
    { domain },
    actor,
  )) as CloudPanelSite;
  if (site.meta?.parent && !SERVICE_SECTIONS.has(section)) notFound();
  const apiBase = `/api/fleet/servers/${serverId}/proxy`;
  if (section === "settings") {
    const [uptime, env] = await Promise.all([
      dispatchFleetAction(serverId, "site.uptime.get", { domain }, actor),
      site.meta?.parent
        ? null
        : dispatchFleetAction(
            serverId,
            "site.section.get",
            { domain, section: "env" },
            actor,
          ).catch(() => null),
    ]);
    return (
      <div className="space-y-5">
        <SiteSettings
          initialSite={site}
          user={session.user}
          uptime={uptime as Parameters<typeof SiteSettings>[0]["uptime"]}
          apiBase={apiBase}
          routeBase={`/fleet/servers/${serverId}`}
        />
        {site.meta && !site.meta.parent ? (
          <LinkedServices parentDomain={domain} canWrite apiBase={apiBase} />
        ) : null}
        {env ? (
          <EnvManager
            domain={domain}
            initialData={env as EnvSectionData}
            canWrite
            apiBase={apiBase}
          />
        ) : null}
      </div>
    );
  }
  if (section === "domains") {
    const certificates = await dispatchFleetAction(
      serverId,
      "site.section.get",
      { domain, section: "certificates" },
      actor,
    );
    return (
      <Section title="Domains">
        <DomainsManager domain={domain} canWrite apiBase={apiBase} />
        <SiteSectionManager
          domain={domain}
          section="certificates"
          initialData={(certificates ?? {}) as Record<string, unknown>}
          apiBase={apiBase}
        />
      </Section>
    );
  }
  if (section === "actions") {
    const [actions, cron, logs] = await Promise.all([
      dispatchFleetAction(
        serverId,
        "site.section.get",
        { domain, section: "actions" },
        actor,
      ),
      dispatchFleetAction(
        serverId,
        "site.section.get",
        { domain, section: "cron-jobs" },
        actor,
      ),
      dispatchFleetAction(
        serverId,
        "site.section.get",
        { domain, section: "logs" },
        actor,
      ),
    ]);
    return (
      <Section title="Operations">
        <ActionsManager
          domain={domain}
          initialData={actions as OperationsData}
          apiBase={apiBase}
        />
        <SiteSectionManager
          domain={domain}
          section="cron-jobs"
          initialData={(cron ?? {}) as Record<string, unknown>}
          apiBase={apiBase}
        />
        <SiteSectionManager
          domain={domain}
          section="logs"
          initialData={(logs ?? {}) as Record<string, unknown>}
          apiBase={apiBase}
        />
      </Section>
    );
  }
  if (section === "security") {
    const [security, users] = await Promise.all([
      dispatchFleetAction(
        serverId,
        "site.section.get",
        { domain, section: "security" },
        actor,
      ),
      dispatchFleetAction(
        serverId,
        "site.section.get",
        { domain, section: "users" },
        actor,
      ),
    ]);
    return (
      <Section title="Security">
        <SiteSectionManager
          domain={domain}
          section="security"
          initialData={(security ?? {}) as Record<string, unknown>}
          apiBase={apiBase}
        />
        <SiteSectionManager
          domain={domain}
          section="users"
          initialData={(users ?? {}) as Record<string, unknown>}
          apiBase={apiBase}
        />
      </Section>
    );
  }
  if (section === "terminal") {
    const [terminal, info] = await Promise.all([
      dispatchFleetAction(
        serverId,
        "site.section.get",
        { domain, section },
        actor,
      ),
      dispatchFleetAction(serverId, "system.info", {}, actor),
    ]);
    return (
      <Section title="Terminal">
        <TerminalManager
          domain={domain}
          initialData={{
            ...(terminal as Omit<TerminalData, "host">),
            host: (info as ServerInfo).ip,
          }}
          canWrite
          apiBase={apiBase}
        />
      </Section>
    );
  }
  if (section === "backups") {
    const [backups, automation] = await Promise.all([
      dispatchFleetAction(
        serverId,
        "site.section.get",
        { domain, section },
        actor,
      ),
      dispatchFleetAction(
        serverId,
        "site.backup-automation.get",
        { domain },
        actor,
      ),
    ]);
    const auto = automation as {
      schedule?: unknown;
      destination?: unknown;
      offsiteBackups?: unknown;
    };
    return (
      <Section title="Backups">
        <BackupsManager
          domain={domain}
          initialData={
            {
              ...(backups as BackupsData),
              schedule: auto.schedule,
              offsite: {
                destination: auto.destination,
                items: auto.offsiteBackups,
              },
            } as BackupsData
          }
          canWrite
          apiBase={apiBase}
        />
      </Section>
    );
  }
  const data = await dispatchFleetAction(
    serverId,
    "site.section.get",
    { domain, section },
    actor,
  );
  if (section === "git")
    return (
      <Section title="Git">
        <GitManager
          domain={domain}
          initialData={data as Parameters<typeof GitManager>[0]["initialData"]}
          apiBase={apiBase}
        />
      </Section>
    );
  if (section === "env")
    return (
      <Section title="Environment">
        <EnvManager
          domain={domain}
          initialData={data as EnvSectionData}
          canWrite
          apiBase={apiBase}
        />
      </Section>
    );
  return (
    <Section title={titles[section]}>
      <SiteSectionManager
        domain={domain}
        section={section}
        initialData={(data ?? {}) as Record<string, unknown>}
        apiBase={apiBase}
        allowLocalSecrets={false}
      />
    </Section>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-ink">{title}</h2>
        <p className="mt-1 text-sm text-slate-500">
          Managing this website through its connected Fleet Node.
        </p>
      </div>
      {children}
    </div>
  );
}
