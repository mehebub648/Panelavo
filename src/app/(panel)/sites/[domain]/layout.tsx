import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, ExternalLink, Globe2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteSectionNav } from "@/components/sites/site-section-nav";

export default async function SiteLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ domain: string }>;
}) {
  const domain = decodeURIComponent((await params).domain);
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            asChild
            variant="outline"
            size="icon"
            className="shrink-0"
            title="Back to websites"
          >
            <Link href="/sites" aria-label="Back to websites">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-panel-50 text-panel-600">
            <Globe2 className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Website
            </p>
            <h1 className="truncate text-xl font-bold tracking-tight text-ink">
              {domain}
            </h1>
          </div>
        </div>
        <Button asChild variant="outline" size="sm">
          <a
            href={`https://${domain}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Visit site <ExternalLink className="h-4 w-4" />
          </a>
        </Button>
      </div>
      <SiteSectionNav domain={domain} />
      {children}
    </div>
  );
}
