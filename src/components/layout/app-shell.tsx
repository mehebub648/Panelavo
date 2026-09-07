"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Activity,
  BadgeInfo,
  Bot,
  Cloud,
  Globe2,
  Server,
  Info,
  LogOut,
  Menu,
  ScrollText,
  Settings,
  Shield,
  UserRound,
  Users,
  X,
} from "lucide-react";
import type { CloudPanelUser } from "@/types/cloudpanel";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  fleetSection,
  fleetSectionHref,
  selectedFleetServer,
} from "@/lib/fleet-navigation";

export function AppShell({
  user,
  children,
}: {
  user: CloudPanelUser;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const superAdmin = user.panelRole === "super-admin";
  const serverId = superAdmin ? selectedFleetServer(pathname) : "local";
  const remote = serverId !== "local";
  const section = pathname.includes("/sites")
    ? "websites"
    : fleetSection(searchParams.get("tab"));
  const [servers, setServers] = useState<Array<{ id: string; label: string }>>(
    [],
  );
  useEffect(() => {
    if (!superAdmin) return;
    const controller = new AbortController();
    void fetch("/api/connections", {
      signal: controller.signal,
      cache: "no-store",
    })
      .then((response) => response.json())
      .then((result) => {
        if (result.success) setServers(result.data.outgoing);
      })
      .catch(() => {
        /* Fleet discovery must not block local management. */
      });
    const refresh = () => {
      void fetch("/api/connections", {
        signal: controller.signal,
        cache: "no-store",
      })
        .then((response) => response.json())
        .then((result) => {
          if (result.success) setServers(result.data.outgoing);
        })
        .catch(() => undefined);
    };
    window.addEventListener("panelavo-connections-changed", refresh);
    return () => {
      controller.abort();
      window.removeEventListener("panelavo-connections-changed", refresh);
    };
  }, [superAdmin, pathname]);
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const title = pathname.startsWith("/servers/")
    ? pathname.endsWith("/sites/new")
      ? "Add website"
      : pathname.includes("/sites/")
        ? "Website workspace"
        : section === "ai-access"
          ? "AI access"
          : section === "settings"
            ? "Panel settings"
            : section[0].toUpperCase() + section.slice(1)
    : pathname === "/switch-server"
      ? "Switch server"
      : pathname.startsWith("/fleet")
        ? "Fleet"
        : pathname === "/domains"
          ? "Domains & DNS"
          : pathname === "/ai-access"
            ? "AI access"
            : pathname === "/settings"
              ? "Panel settings"
              : pathname === "/vpn"
                ? "WireGuard VPN"
                : pathname === "/users"
                  ? "User management"
                  : pathname === "/audit"
                    ? "Audit trail"
                    : pathname === "/resources"
                      ? "Server resources"
                      : pathname === "/about"
                        ? "About panelavo"
                        : pathname === "/information"
                          ? "Server information"
                          : pathname === "/profile"
                            ? "My profile"
                            : pathname === "/sites/new"
                              ? "Add website"
                              : pathname.split("/").length > 3
                                ? "Website workspace"
                                : "Websites";
  const elevated = ["super-admin", "manager"].includes(user.panelRole ?? "");
  const nav = remote
    ? [
        {
          href: fleetSectionHref(serverId, "websites"),
          label: "Websites",
          icon: Globe2,
        },
        {
          href: fleetSectionHref(serverId, "domains"),
          label: "Domains",
          icon: Cloud,
        },
        {
          href: fleetSectionHref(serverId, "ai-access"),
          label: "AI access",
          icon: Bot,
        },
        {
          href: fleetSectionHref(serverId, "resources"),
          label: "Resources",
          icon: Activity,
        },
        {
          href: fleetSectionHref(serverId, "information"),
          label: "Information",
          icon: Info,
        },
        { href: fleetSectionHref(serverId, "vpn"), label: "VPN", icon: Shield },
        {
          href: fleetSectionHref(serverId, "about"),
          label: "About",
          icon: BadgeInfo,
        },
        {
          href: fleetSectionHref(serverId, "users"),
          label: "Users",
          icon: Users,
        },
        {
          href: fleetSectionHref(serverId, "audit"),
          label: "Audit",
          icon: ScrollText,
        },
        {
          href: fleetSectionHref(serverId, "settings"),
          label: "Settings",
          icon: Settings,
        },
      ]
    : [
        { href: "/sites", label: "Websites", icon: Globe2 },
        { href: "/domains", label: "Domains", icon: Cloud },
        { href: "/ai-access", label: "AI access", icon: Bot },
        ...(elevated
          ? [{ href: "/resources", label: "Resources", icon: Activity }]
          : []),
        ...(elevated
          ? [{ href: "/information", label: "Information", icon: Info }]
          : []),
        ...(user.panelRole === "super-admin"
          ? [{ href: "/vpn", label: "VPN", icon: Shield }]
          : []),
        { href: "/about", label: "About", icon: BadgeInfo },
        ...(user.panelRole === "super-admin"
          ? [{ href: "/users", label: "Users", icon: Users }]
          : []),
        ...(user.panelRole === "super-admin"
          ? [{ href: "/audit", label: "Audit", icon: ScrollText }]
          : []),
        ...(user.panelRole === "super-admin"
          ? [{ href: "/settings", label: "Settings", icon: Settings }]
          : []),
      ];
  async function logout() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }
  const sidebar = (
    <>
      <div className="flex h-20 items-center border-b border-slate-100 px-6">
        <Brand />
      </div>
      <nav className="flex-1 space-y-1 px-3 py-6" aria-label="Main navigation">
        {nav.map(({ href, label, icon: Icon }) => {
          const active = href.includes("?tab=")
            ? href === fleetSectionHref(serverId, section)
            : pathname === href;
          return (
            <Link
              key={href}
              href={href}
              onClick={() => setOpen(false)}
              className={cn(
                "flex h-11 items-center gap-3 rounded-lg px-3.5 text-sm font-semibold transition",
                active
                  ? "bg-panel-50 text-panel-700"
                  : "text-slate-500 hover:bg-slate-50 hover:text-slate-900",
              )}
            >
              <Icon className="h-[18px] w-[18px]" />
              {label}
            </Link>
          );
        })}
      </nav>
      {superAdmin && (
        <div className="border-t border-slate-100 p-4">
          <Link
            aria-label="Switch server"
            href={`/switch-server?from=${encodeURIComponent(pathname + (searchParams.get("tab") ? `?tab=${searchParams.get("tab")}` : ""))}`}
            onClick={() => setOpen(false)}
            className="flex items-center gap-3 rounded-xl bg-panel-50 p-3 text-panel-700 transition hover:bg-panel-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-panel-500"
          >
            <Server className="h-5 w-5 shrink-0 text-panel-600" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Switch server</p>
              <p className="mt-0.5 truncate text-xs text-slate-500">
                {remote
                  ? servers.find((server) => server.id === serverId)?.label ||
                    "Connected server"
                  : "This server"}
              </p>
            </div>
          </Link>
          <Link
            href="/settings#connected-servers"
            onClick={() => setOpen(false)}
            className="mt-2 block px-3 text-xs font-medium text-panel-700"
          >
            Manage connections on this panel
          </Link>
        </div>
      )}
    </>
  );
  return (
    <div className="min-h-screen bg-[#f7f9fc]">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-slate-200/80 bg-white lg:flex">
        {sidebar}
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            aria-label="Close navigation"
            className="absolute inset-0 bg-slate-950/30"
            onClick={() => setOpen(false)}
          />
          <aside className="relative flex h-full w-[280px] flex-col bg-white shadow-2xl">
            {sidebar}
          </aside>
        </div>
      )}
      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex min-h-20 flex-wrap items-center justify-between gap-y-2 border-b border-slate-200/80 bg-white/95 px-4 py-3 backdrop-blur sm:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              aria-label="Open navigation"
              onClick={() => setOpen(true)}
            >
              {open ? <X /> : <Menu />}
            </Button>
            <div className="min-w-0">
              <h1 className="text-xl font-bold tracking-tight text-ink">
                {title}
              </h1>
              <p
                className={
                  remote
                    ? "mt-0.5 max-w-56 truncate text-xs font-medium text-panel-700"
                    : "mt-0.5 hidden text-xs text-slate-400 sm:block"
                }
              >
                {remote
                  ? servers.find((server) => server.id === serverId)?.label ||
                    "Connected server"
                  : title === "Website workspace"
                    ? "Configure and maintain your website"
                    : title === "AI access"
                      ? "Connect an assistant to the websites you can access"
                      : title === "About panelavo"
                        ? "Product details and project notices"
                        : title === "WireGuard VPN"
                          ? "Private, full-tunnel internet access from this server"
                          : "Manage your server websites"}
              </p>
            </div>
          </div>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button className="flex items-center gap-3 rounded-xl px-2 py-1.5 text-left outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-panel-500">
                <span className="hidden text-right sm:block">
                  <span className="block text-sm font-semibold text-slate-800">
                    {user.username}
                  </span>
                  <span className="block text-xs capitalize text-slate-400">
                    {user.panelRole?.replace("-", " ") || "Server user"}
                  </span>
                </span>
                <span className="grid h-9 w-9 place-items-center rounded-full bg-panel-100 text-panel-700">
                  <UserRound className="h-4 w-4" />
                </span>
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={8}
                className="z-50 min-w-48 rounded-xl border border-slate-200 bg-white p-1.5 shadow-card"
              >
                <DropdownMenu.Label className="px-2.5 py-2 text-xs text-slate-400">
                  Signed in as {user.username}
                  {remote ? " on this panel" : ""}
                </DropdownMenu.Label>
                <DropdownMenu.Separator className="my-1 h-px bg-slate-100" />
                <DropdownMenu.Item
                  onSelect={() => router.push("/profile")}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-slate-700 outline-none hover:bg-slate-50"
                >
                  <UserRound className="h-4 w-4" />
                  {remote ? "My profile on this panel" : "My profile"}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={logout}
                  disabled={loggingOut}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-red-600 outline-none hover:bg-red-50"
                >
                  <LogOut className="h-4 w-4" />
                  {loggingOut ? "Signing out…" : "Sign out"}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </header>
        <main className="px-4 py-7 sm:px-8 sm:py-9">{children}</main>
      </div>
    </div>
  );
}
