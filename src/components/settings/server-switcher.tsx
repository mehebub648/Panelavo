"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Check, Link2, Search, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { selectedFleetServer, switchFleetServer } from "@/lib/fleet-navigation";

type ServerChoice = {
  id: string;
  label: string;
  origin: string;
  status: string;
  fullAccess?: boolean;
};

export function ServerSwitcher() {
  const params = useSearchParams();
  let from: URL;
  try {
    from = new URL(params.get("from") || "/sites", "https://panel.invalid");
  } catch {
    from = new URL("/sites", "https://panel.invalid");
  }
  const current = selectedFleetServer(from.pathname);
  const [servers, setServers] = useState<ServerChoice[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/connections", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => response.json())
      .then((result) => {
        if (!result.success)
          throw new Error(
            result.error?.message || "Could not load connected servers.",
          );
        setServers(result.data.outgoing);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);
  const choices = [
    {
      id: "local",
      label: "This server",
      origin: "The panel you signed in to",
      status: "local",
      fullAccess: true,
    },
    ...servers,
  ];
  const filtered = choices.filter((server) =>
    `${server.label} ${server.origin}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <div className="mx-auto max-w-5xl space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-panel-600">
            Your workspace
          </p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight text-ink">
            Where would you like to work?
          </h2>
          <p className="mt-3 max-w-xl text-sm leading-6 text-slate-500">
            Choose a server and pick up where you left off. Your connected
            servers, together in one place.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/settings#connected-servers">
            <Link2 className="h-4 w-4" />
            Connect a server
          </Link>
        </Button>
      </div>
      <div className="relative max-w-lg">
        <Search className="absolute left-3.5 top-3 h-4 w-4 text-slate-400" />
        <Input
          aria-label="Search servers"
          placeholder="Search by nickname or address"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="bg-white pl-10"
        />
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"
        >
          {error} This server is still available below.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {filtered.map((server) => (
          <Link
            key={server.id}
            href={
              server.fullAccess
                ? switchFleetServer(
                    server.id,
                    from.pathname,
                    from.searchParams.get("tab"),
                  )
                : "/settings#connected-servers"
            }
            className={`hover:border-panel-300 group flex min-h-60 flex-col rounded-2xl border bg-white p-6 transition hover:-translate-y-0.5 hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-panel-500 ${current === server.id ? "border-panel-300 ring-1 ring-panel-100" : "border-slate-200"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-panel-50 text-panel-600">
                <Server className="h-6 w-6" />
              </span>
              {current === server.id && (
                <span className="inline-flex items-center gap-1 rounded-full bg-panel-50 px-2.5 py-1 text-xs font-medium text-panel-700">
                  <Check className="h-3 w-3" />
                  Current
                </span>
              )}
            </div>
            <h3 className="mt-5 break-words text-lg font-bold text-ink">
              {server.label}
            </h3>
            <p className="mt-1 break-all text-xs leading-5 text-slate-500">
              {server.origin.replace(/^https:\/\//, "")}
            </p>
            <div className="mt-auto flex items-center justify-between gap-3 pt-6">
              <span className="inline-flex items-center gap-2 text-xs text-slate-500">
                <span
                  className={`h-2 w-2 rounded-full ${["online", "local"].includes(server.status) ? "bg-emerald-500" : server.status === "degraded" ? "bg-amber-500" : "bg-slate-300"}`}
                />
                {!server.fullAccess
                  ? "Limited connection"
                  : server.status === "local"
                    ? "Local panel"
                    : `Last check: ${server.status}`}
              </span>
              <span className="inline-flex items-center gap-1 text-sm font-semibold text-panel-700">
                {server.fullAccess ? "Open" : "Reconnect"}
                <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
              </span>
            </div>
          </Link>
        ))}
      </div>
      {loading && (
        <p role="status" className="text-sm text-slate-500">
          Loading connected servers…
        </p>
      )}
      {!loading && !filtered.length && (
        <p className="rounded-2xl border border-dashed border-slate-200 p-10 text-center text-slate-500">
          No servers match your search.
        </p>
      )}
      {!loading && !servers.length && !error && (
        <p className="text-sm text-slate-500">
          Connect your first server in Settings using a single-use token. Only
          servers shared with this panel appear here.
        </p>
      )}
    </div>
  );
}
