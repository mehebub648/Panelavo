"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarClock, Code2, Database, Files, KeyRound, Settings,
  ShieldCheck, TerminalSquare, UsersRound,
} from "lucide-react";
import { cn } from "@/lib/utils";

const sections = [
  ["settings", "Settings", Settings],
  ["vhost", "Vhost", Code2],
  ["databases", "Databases", Database],
  ["certificates", "SSL/TLS", KeyRound],
  ["security", "Security", ShieldCheck],
  ["users", "SSH/FTP", UsersRound],
  ["file-manager", "Files", Files],
  ["cron-jobs", "Cron jobs", CalendarClock],
  ["logs", "Logs", TerminalSquare],
] as const;

export function SiteSectionNav({ domain }: { domain: string }) {
  const pathname = usePathname();
  const base = `/sites/${encodeURIComponent(domain)}`;
  return (
    <div className="-mx-4 overflow-x-auto border-b border-slate-200 px-4 sm:-mx-8 sm:px-8">
      <nav className="flex min-w-max gap-1" aria-label={`${domain} tools`}>
        {sections.map(([path, label, Icon]) => {
          const href = `${base}/${path}`;
          const active = pathname === href;
          return (
            <Link key={path} href={href} aria-current={active ? "page" : undefined}
              className={cn("relative flex h-12 items-center gap-2 rounded-t-lg px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-panel-500",
                active ? "bg-white text-panel-700 after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-panel-600" : "text-slate-500 hover:bg-white/70 hover:text-slate-900")}
            >
              <Icon className="h-4 w-4" />{label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
