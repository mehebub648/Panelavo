"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarClock,
  Code2,
  Database,
  Files,
  GitBranch,
  KeyRound,
  Settings,
  ShieldCheck,
  TerminalSquare,
  UsersRound,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

const sections = [
  ["settings", "Settings", Settings],
  ["actions", "Actions", Zap],
  ["vhost", "Vhost", Code2],
  ["databases", "Databases", Database],
  ["certificates", "SSL/TLS", KeyRound],
  ["security", "Security", ShieldCheck],
  ["users", "SSH/FTP", UsersRound],
  ["file-manager", "Files", Files],
  ["git", "Git", GitBranch],
  ["cron-jobs", "Cron jobs", CalendarClock],
  ["logs", "Logs", TerminalSquare],
] as const;

export function SiteSectionNav({ domain }: { domain: string }) {
  const pathname = usePathname();
  const base = `/sites/${encodeURIComponent(domain)}`;
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:-mx-8 sm:px-8 pb-1">
      <nav className="flex min-w-max gap-2 p-1 rounded-2xl bg-slate-100/50 backdrop-blur-sm border border-slate-200/60" aria-label={`${domain} tools`}>
        {sections.map(([path, label, Icon]) => {
          const href = `${base}/${path}`;
          const active = pathname === href;
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
