import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink, Globe2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteSectionNav } from "@/components/sites/site-section-nav";
import { panelActorFromSession } from "@/server/auth/site-access";
import { requireFleetSuperAdminOrRedirect } from "@/server/fleet/auth";
import { dispatchFleetAction } from "@/server/fleet/service";
import type { CloudPanelSite } from "@/types/cloudpanel";

export default async function FleetSiteLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ serverId: string; domain: string }>;
}) {
  const session = await requireFleetSuperAdminOrRedirect({
    allowDuringUpdate: true,
  });
  if (!session) notFound();
  const { serverId, domain: encoded } = await params;
  const domain = decodeURIComponent(encoded);
  const site = (await dispatchFleetAction(
    serverId,
    "site.get",
    { domain },
    panelActorFromSession(session),
  )) as CloudPanelSite;
  const displayDomain =
    typeof site.meta?.aliases?.[0] === "string" ? site.meta.aliases[0] : domain;
  const routeBase = `/fleet/servers/${serverId}/sites`;
  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <Button asChild variant="outline" size="icon">
            <Link
              href={`/fleet/servers/${serverId}`}
              aria-label="Back to server"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-panel-50 text-panel-600">
            <Globe2 />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-400">
              Fleet website
            </p>
            <h1 className="truncate text-2xl font-bold text-ink">
              {site.label || displayDomain}
            </h1>
            <p className="text-xs text-slate-400">{domain}</p>
          </div>
        </div>
        <Button asChild variant="outline" size="sm">
          <a
            href={`https://${displayDomain}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Visit site <ExternalLink className="h-4 w-4" />
          </a>
        </Button>
      </div>
      <SiteSectionNav
        domain={domain}
        serviceSite={Boolean(site.meta?.parent)}
        routeBase={routeBase}
      />
      {children}
    </div>
  );
}
