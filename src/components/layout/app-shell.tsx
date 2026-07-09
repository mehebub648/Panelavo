"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Cloud, Globe2, LogOut, Menu, UserRound, Users, X } from "lucide-react";
import type { CloudPanelUser } from "@/types/cloudpanel";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function AppShell({
  user,
  children,
}: {
  user: CloudPanelUser;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const title =
    pathname === "/domains"
      ? "Domains & DNS"
      : pathname === "/users"
        ? "User management"
        : pathname === "/sites/new"
      ? "Add website"
      : pathname.split("/").length > 3
        ? "Website workspace"
        : "Websites";
  const nav = [
    { href: "/sites", label: "Websites", icon: Globe2 },
    { href: "/domains", label: "Domains", icon: Cloud },
    ...(user.panelRole === "super-admin" ? [{ href: "/users", label: "Users", icon: Users }] : []),
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
          const active = pathname === href;
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
      <div className="border-t border-slate-100 p-4">
        <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-panel-100 text-sm font-bold text-panel-700">
            {user.username.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-800">
              {user.displayName || user.username}
            </p>
            <p className="truncate text-xs capitalize text-slate-400">
              {user.panelRole?.replace("-", " ") || "CloudPanel user"}
            </p>
          </div>
        </div>
      </div>
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
        <header className="sticky top-0 z-20 flex h-20 items-center justify-between border-b border-slate-200/80 bg-white/95 px-4 backdrop-blur sm:px-8">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              aria-label="Open navigation"
              onClick={() => setOpen(true)}
            >
              {open ? <X /> : <Menu />}
            </Button>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-ink">
                {title}
              </h1>
              <p className="mt-0.5 hidden text-xs text-slate-400 sm:block">
                {title === "Website workspace"
                  ? "Configure and maintain your website"
                  : "Manage your CloudPanel websites"}
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
                    {user.panelRole?.replace("-", " ") || "CloudPanel user"}
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
                </DropdownMenu.Label>
                <DropdownMenu.Separator className="my-1 h-px bg-slate-100" />
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
