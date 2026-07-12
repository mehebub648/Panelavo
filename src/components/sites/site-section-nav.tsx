"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Archive,
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

const sections = [
  ["settings", "Settings", Settings],
  ["domains", "Domains", Globe2],
  ["actions", "Operations", Zap],
  ["vhost", "Vhost", Code2],
  ["databases", "Databases", Database],
  ["security", "Security", ShieldCheck],
  ["file-manager", "Files", Files],
  ["git", "Git", GitBranch],
  ["terminal", "Terminal", SquareTerminal],
  ["backups", "Backups", Archive],
] as const;

const sectionGroups: Record<string, readonly string[]> = {
  domains: ["domains", "certificates"],
  actions: ["actions", "cron-jobs", "logs"],
  security: ["security", "users"],
};

export function SiteSectionNav({ domain }: { domain: string }) {
  const pathname = usePathname();
  const base = `/sites/${encodeURIComponent(domain)}`;
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:-mx-8 sm:px-8 pb-1">
      <nav className="flex min-w-max gap-2 p-1 rounded-2xl bg-slate-100/50 backdrop-blur-sm border border-slate-200/60" aria-label={`${domain} tools`}>
        {sections.map(([path, label, Icon]) => {
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
              <Icon className={cn("h-4 w-4 transition-colors", active ? "text-panel-600" : "text-slate-400")} />
              {label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
