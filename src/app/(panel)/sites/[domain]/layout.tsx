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
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <Button
              asChild
              variant="outline"
              size="icon"
              className="shrink-0 rounded-full border-slate-200/50 bg-white/50 backdrop-blur-sm transition-all hover:bg-white hover:shadow-sm"
              title="Back to websites"
            >
              <Link href="/sites" aria-label="Back to websites">
                <ArrowLeft className="h-4 w-4" />
              </Link>
            </Button>
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-panel-50 to-panel-100 shadow-sm text-panel-600 ring-1 ring-white/60">
              <Globe2 className="h-6 w-6" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Website
              </p>
              <h1 className="truncate text-2xl font-extrabold tracking-tight text-ink drop-shadow-sm">
                {domain}
              </h1>
            </div>
          </div>
          <Button asChild variant="outline" size="sm" className="rounded-full shadow-sm bg-white/70 backdrop-blur-sm transition-all hover:bg-white hover:shadow-md">
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
