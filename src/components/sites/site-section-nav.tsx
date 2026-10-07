"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Archive,
  ChevronDown,
  Code2,
  Database,
  Files,
  GitBranch,
  Globe2,
  Settings,
  ShieldCheck,
  SquareTerminal,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SERVICE_SECTIONS } from "@/components/sites/site-sections";

const primarySections = [
  ["settings", "Settings", Settings],
  ["domains", "Domains", Globe2],
  ["actions", "Operations", Zap],
  ["databases", "Databases", Database],
  ["security", "Security", ShieldCheck],
  ["file-manager", "Files", Files],
  ["backups", "Backups", Archive],
] as const;

const developerSections = [
  ["vhost", "Vhost", Code2],
  ["git", "Git & Deploy", GitBranch],
  ["terminal", "Terminal", SquareTerminal],
] as const;

const sectionGroups: Record<string, readonly string[]> = {
  domains: ["domains", "certificates"],
  actions: ["actions", "cron-jobs", "logs"],
  security: ["security", "users"],
};

export function SiteSectionNav({
  domain,
  serviceSite = false,
  routeBase = "/sites",
}: {
  domain: string;
  serviceSite?: boolean;
  routeBase?: string;
}) {
  const pathname = usePathname();
  const base = `${routeBase}/${encodeURIComponent(domain)}`;
  const visible = serviceSite
    ? primarySections.filter(([path]) => SERVICE_SECTIONS.has(path))
    : primarySections;
  const activeDeveloper = developerSections.find(
    ([path]) => pathname === `${base}/${path}`,
  );
  return (
    <div className="-mx-4 px-4 pb-1 sm:-mx-8 sm:px-8">
      <nav
        className="flex flex-wrap gap-2 rounded-2xl border border-slate-200/60 bg-slate-100/50 p-1 backdrop-blur-sm"
        aria-label={`${domain} tools`}
      >
        {visible.map(([path, label, Icon]) => {
          const href = `${base}/${path}`;
          const active = (sectionGroups[path] ?? [path]).some(
            (section) => pathname === `${base}/${section}`,
          );
          return (
            <Link
              key={path}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex h-10 items-center gap-2 rounded-xl px-4 text-sm font-medium transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-panel-500",
                active
                  ? "bg-white text-panel-700 shadow-sm ring-1 ring-slate-200/50"
                  : "text-slate-500 hover:bg-slate-200/50 hover:text-slate-900",
              )}
            >
              <Icon
                className={cn(
                  "h-4 w-4 transition-colors",
                  active ? "text-panel-600" : "text-slate-400",
                )}
              />
              {label}
            </Link>
          );
        })}
        {!serviceSite && (
          <details className="group relative">
            <summary
              aria-current={activeDeveloper ? "page" : undefined}
              className={cn(
                "flex h-10 cursor-pointer list-none items-center gap-2 rounded-xl px-4 text-sm font-medium transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-panel-500 [&::-webkit-details-marker]:hidden",
                activeDeveloper
                  ? "bg-white text-panel-700 shadow-sm ring-1 ring-slate-200/50"
                  : "text-slate-500 hover:bg-slate-200/50 hover:text-slate-900",
              )}
            >
              <Code2
                className={cn(
                  "h-4 w-4",
                  activeDeveloper ? "text-panel-600" : "text-slate-400",
                )}
              />
              {activeDeveloper
                ? `Developer tools: ${activeDeveloper[1]}`
                : "Developer tools"}
              <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
            </summary>
            <div className="absolute right-0 z-30 mt-2 w-52 space-y-1 rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
              {developerSections.map(([path, label, Icon]) => {
                const href = `${base}/${path}`;
                const active = pathname === href;
                return (
                  <Link
                    key={path}
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-panel-500",
                      active
                        ? "bg-panel-50 text-panel-700"
                        : "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </Link>
                );
              })}
            </div>
          </details>
        )}
      </nav>
    </div>
  );
}
