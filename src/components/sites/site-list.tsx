"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Braces,
  Check,
  Clipboard,
  Code2,
  Container,
  CornerDownRight,
  ExternalLink,
  FileCode2,
  Globe2,
  Network,
  Plus,
  RefreshCw,
  Search,
  Server,
  ServerCrash,
  Settings,
} from "lucide-react";
import { toast } from "sonner";
import type {
  CloudPanelSite,
  CloudPanelUser,
  SiteType,
} from "@/types/cloudpanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { formatDate } from "@/lib/utils";

const typeLabels: Record<SiteType, string> = {
  php: "PHP",
  nodejs: "Node.js",
  static: "Static HTML",
  python: "Python",
  "reverse-proxy": "Reverse proxy",
  docker: "Docker",
};
const typeVisuals: Record<SiteType, { icon: typeof Globe2; color: string }> = {
  php: { icon: Code2, color: "bg-violet-50 text-violet-600" },
  nodejs: { icon: Braces, color: "bg-emerald-50 text-emerald-600" },
  static: { icon: FileCode2, color: "bg-amber-50 text-amber-600" },
  python: { icon: Server, color: "bg-blue-50 text-blue-600" },
  "reverse-proxy": { icon: Network, color: "bg-rose-50 text-rose-600" },
  docker: { icon: Container, color: "bg-sky-50 text-sky-600" },
};
function SiteIcon({ type, className }: { type?: SiteType; className?: string }) {
  const visual = (type && typeVisuals[type]) || { icon: Globe2, color: "bg-panel-50 text-panel-600" };
  const Icon = visual.icon;
  return (
    <span className={`grid shrink-0 place-items-center rounded-xl ${visual.color} ${className ?? "h-10 w-10"}`}>
      <Icon className="h-4 w-4" />
    </span>
  );
}
function TypeBadge({ type }: { type?: SiteType }) {
  return (
    <span className="inline-flex rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
      {type ? typeLabels[type] : "—"}
    </span>
  );
}
function Status({ status }: { status?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700">
      <span
        className={`h-1.5 w-1.5 rounded-full ${status === "inactive" ? "bg-slate-400" : "bg-emerald-500"}`}
      />
      {status === "inactive"
        ? "Inactive"
        : status === "unknown"
          ? "Unknown"
          : "Active"}
    </span>
  );
}

export function SiteList({ user }: { user: CloudPanelUser }) {
  const router = useRouter();
  const params = useSearchParams();
  const [sites, setSites] = useState<CloudPanelSite[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [copied, setCopied] = useState("");
  const load = useCallback(
    async (refresh = false) => {
      if (refresh) setRefreshing(true);
      else setLoading(true);
      setError("");
      try {
        const response = await fetch("/api/sites", { cache: "no-store" });
        const result = await response.json();
        if (response.status === 401) {
          router.replace("/login?reason=session-expired");
          return;
        }
        if (!result.success)
          throw new Error(
            result.error?.message || "Websites could not be loaded.",
          );
        setSites(result.data.sites);
        if (refresh) toast.success("Website list refreshed");
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Websites could not be loaded.",
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [router],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const created = params.get("created");
    if (created) {
      toast.success(`${created} was created`);
      router.replace("/sites", { scroll: false });
    }
  }, [params, router]);
  const types = useMemo(
    () =>
      [
        ...new Set(sites.map((site) => site.type).filter(Boolean)),
      ] as SiteType[],
    [sites],
  );
  const filtered = useMemo(() => {
    const matches = sites.filter(
      (site) =>
        (type === "all" || site.type === type) &&
        [
          site.domain,
          site.siteUser,
          site.application,
          site.runtimeVersion,
          site.meta?.serviceName,
        ].some((value) => value?.toLowerCase().includes(query.toLowerCase())),
    );
    // Linked services render right under their parent; a service whose parent
    // is filtered out (or not visible) stays as a top-level row.
    const visible = new Set(matches.map((site) => site.domain.toLowerCase()));
    const children = new Map<string, CloudPanelSite[]>();
    const roots: CloudPanelSite[] = [];
    for (const site of matches) {
      const parent =
        typeof site.meta?.parent === "string" ? site.meta.parent : "";
      if (parent && visible.has(parent))
        children.set(parent, [...(children.get(parent) ?? []), site]);
      else roots.push(site);
    }
    return roots.flatMap((site) => [
      site,
      ...(children.get(site.domain.toLowerCase()) ?? []),
    ]);
  }, [sites, query, type]);
  async function copy(domain: string) {
    await navigator.clipboard.writeText(domain);
    setCopied(domain);
    toast.success("Domain copied");
    setTimeout(() => setCopied(""), 1400);
  }

  if (loading)
    return (
      <div className="space-y-5">
        <div className="h-24 animate-pulse rounded-2xl border border-slate-200 bg-white" />
        <div className="h-72 animate-pulse rounded-2xl border border-slate-200 bg-white" />
      </div>
    );
  if (error)
    return (
      <div className="grid min-h-[420px] place-items-center rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-card">
        <div>
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-red-50 text-red-600">
            <ServerCrash />
          </span>
          <h2 className="mt-5 text-lg font-bold">Couldn’t load websites</h2>
          <p className="mt-2 max-w-md text-sm text-slate-500">{error}</p>
          <Button className="mt-5" onClick={() => load()}>
            Try again
          </Button>
        </div>
      </div>
    );
  return (
    <div className="mx-auto max-w-[1380px] space-y-5">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-ink">
            Your websites
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {sites.length} {sites.length === 1 ? "website" : "websites"}{" "}
            available to your CloudPanel account
          </p>
        </div>
        {user.canCreateSites && (
          <Button asChild>
            <Link href="/sites/new">
              <Plus className="h-4 w-4" />
              Add website
            </Link>
          </Button>
        )}
      </div>
      <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-card">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search domains, users, or runtimes…"
              className="pl-10 shadow-none"
              aria-label="Search websites"
            />
          </div>
          {types.length > 1 && (
            <Select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full shadow-none sm:w-44"
              aria-label="Filter by site type"
            >
              <option value="all">All site types</option>
              {types.map((item) => (
                <option key={item} value={item}>
                  {typeLabels[item]}
                </option>
              ))}
            </Select>
          )}
          <Button
            variant="outline"
            size="icon"
            onClick={() => load(true)}
            disabled={refreshing}
            aria-label="Refresh websites"
          >
            <RefreshCw
              className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
            />
          </Button>
        </div>
        {sites.length === 0 ? (
          <div className="grid min-h-[420px] place-items-center p-8 text-center">
            <div>
              <span className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-panel-50 text-panel-600">
                <Globe2 className="h-7 w-7" />
              </span>
              <h3 className="mt-5 text-xl font-bold">No websites found</h3>
              <p className="mt-2 text-sm text-slate-500">
                Create your first website to start hosting an application.
              </p>
              {user.canCreateSites && (
                <Button asChild className="mt-6">
                  <Link href="/sites/new">
                    <Plus className="h-4 w-4" />
                    Create website
                  </Link>
                </Button>
              )}
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="grid min-h-64 place-items-center p-8 text-center">
            <div>
              <Search className="mx-auto h-7 w-7 text-slate-300" />
              <p className="mt-3 font-semibold">No matching websites</p>
              <button
                className="mt-2 text-sm font-medium text-panel-600"
                onClick={() => {
                  setQuery("");
                  setType("all");
                }}
              >
                Clear filters
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-slate-50/70 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                    <th className="px-6 py-3.5">Domain</th>
                    <th className="px-4 py-3.5">Type</th>
                    <th className="px-4 py-3.5">Runtime</th>
                    <th className="px-4 py-3.5">Site user</th>
                    <th className="px-4 py-3.5">Status</th>
                    <th className="px-4 py-3.5">Created</th>
                    <th className="px-6 py-3.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((site) => (
                    <tr key={site.id} className="group hover:bg-slate-50/50">
                      <td className="px-6 py-4">
                        <div
                          className={`flex items-center gap-3 ${site.meta?.parent ? "pl-6" : ""}`}
                        >
                          {site.meta?.parent && (
                            <CornerDownRight className="h-4 w-4 shrink-0 text-slate-300" />
                          )}
                          <SiteIcon type={site.type} className="h-9 w-9" />
                          <div>
                            <p className="flex items-center gap-2 font-semibold text-slate-800">
                              {site.meta?.aliases?.[0] || site.domain}
                              {site.meta?.parent && (
                                <span className="rounded-md bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-500">
                                  {site.meta?.serviceName || "service"}
                                </span>
                              )}
                            </p>
                            <p className="mt-0.5 text-[11px] text-slate-400">
                              {(site.meta?.aliases?.[0] && site.meta?.aliases?.[0] !== site.domain) ? `ID: ${site.domain}` : ""}
                              {site.application && (site.meta?.aliases?.[0] && site.meta?.aliases?.[0] !== site.domain) ? <span className="mx-1.5 opacity-50">•</span> : ""}
                              {site.application || (!(site.meta?.aliases?.[0] && site.meta?.aliases?.[0] !== site.domain) ? "—" : "")}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <TypeBadge type={site.type} />
                      </td>
                      <td className="px-4 py-4 text-sm text-slate-600">
                        {site.runtimeVersion || "—"}
                      </td>
                      <td className="px-4 py-4 text-sm text-slate-600">
                        {site.siteUser || "—"}
                      </td>
                      <td className="px-4 py-4">
                        <Status status={site.status} />
                      </td>
                      <td className="px-4 py-4 text-sm text-slate-500">
                        {formatDate(site.createdAt)}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon" asChild>
                            <Link href={`/sites/${encodeURIComponent(site.domain)}`} aria-label={`Manage ${site.domain}`}>
                              <Settings className="h-4 w-4" />
                            </Link>
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => copy(site.domain)}
                            aria-label={`Copy ${site.domain}`}
                          >
                            {copied === site.domain ? (
                              <Check className="h-4 w-4 text-emerald-600" />
                            ) : (
                              <Clipboard className="h-4 w-4" />
                            )}
                          </Button>
                          <Button variant="ghost" size="icon" asChild>
                            <a
                              href={site.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`Open ${site.domain}`}
                            >
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-3 p-3 md:hidden">
              {filtered.map((site) => (
                <article
                  key={site.id}
                  className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm"
                >
                  <div className="flex items-start gap-3 p-4">
                    <SiteIcon type={site.type} />
                    <div className="min-w-0 flex-1">
                      {/* Tapping the domain copies it — no separate copy button. */}
                      <button
                        type="button"
                        onClick={() => copy(site.meta?.aliases?.[0] || site.domain)}
                        className="flex w-full items-center gap-1.5 text-left"
                        aria-label={`Copy ${site.meta?.aliases?.[0] || site.domain}`}
                      >
                        <span className="truncate font-semibold text-slate-800">{site.meta?.aliases?.[0] || site.domain}</span>
                        {site.meta?.parent && (
                          <span className="shrink-0 rounded-md bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-500">
                            {site.meta?.serviceName || "service"}
                          </span>
                        )}
                        {copied === (site.meta?.aliases?.[0] || site.domain) ? (
                          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                        ) : (
                          <Clipboard className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                        )}
                      </button>
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">
                        {(site.meta?.aliases?.[0] && site.meta?.aliases?.[0] !== site.domain) ? (
                          <>
                            <span className="font-mono" title="System ID">{site.domain}</span>
                            <span className="text-slate-200">•</span>
                          </>
                        ) : null}
                        <span>{typeLabels[site.type as SiteType] ?? "Website"}</span>
                        {site.runtimeVersion && (
                          <>
                            <span className="text-slate-200">•</span>
                            <span>{site.runtimeVersion}</span>
                          </>
                        )}
                        {site.siteUser && (
                          <>
                            <span className="text-slate-200">•</span>
                            <span>{site.siteUser}</span>
                          </>
                        )}
                      </p>
                    </div>
                    <Status status={site.status} />
                  </div>
                  <div className="grid grid-cols-2 divide-x divide-slate-100 border-t border-slate-100 bg-slate-50/40">
                    <Link
                      href={`/sites/${encodeURIComponent(site.domain)}`}
                      className="flex h-11 items-center justify-center gap-2 text-sm font-semibold text-panel-700 active:bg-panel-50"
                    >
                      <Settings className="h-4 w-4" /> Manage
                    </Link>
                    <a
                      href={site.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex h-11 items-center justify-center gap-2 text-sm font-semibold text-slate-600 active:bg-slate-100"
                    >
                      <ExternalLink className="h-4 w-4" /> Open site
                    </a>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
