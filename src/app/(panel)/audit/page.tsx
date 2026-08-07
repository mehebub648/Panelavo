import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Search,
  ShieldAlert,
} from "lucide-react";
import { requireUserOrRedirect } from "@/server/auth/require-user";
import { auditQueryFromSearchParams } from "@/server/security/audit-query";
import { readAuditEvents, type AuditEvent } from "@/server/security/log";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Audit trail" };

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function actor(event: AuditEvent) {
  return event.actor?.username || event.actor?.id || "system";
}

function target(event: AuditEvent) {
  return event.target?.id || event.target?.type || "panel";
}

function eventContext(event: AuditEvent) {
  const value = {
    ...(event.request ? { request: event.request } : {}),
    ...(event.client ? { client: event.client } : {}),
    ...(event.details ? { details: event.details } : {}),
  };
  return Object.keys(value).length ? JSON.stringify(value, null, 2) : "";
}

function pageHref(params: URLSearchParams, page: number) {
  const next = new URLSearchParams(params);
  next.set("page", String(page));
  return "/audit?" + next.toString();
}

export default async function AuditPage({ searchParams }: PageProps) {
  const session = await requireUserOrRedirect({ allowDuringUpdate: true });
  if (session.user.panelRole !== "super-admin") redirect("/sites");

  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const name of [
    "user",
    "site",
    "action",
    "result",
    "from",
    "to",
    "page",
  ]) {
    const value = first(raw[name]);
    if (value) params.set(name, value);
  }
  const page = await readAuditEvents(auditQueryFromSearchParams(params));
  const context = page.events.map(eventContext);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-ink">
            Tamper-evident audit trail
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Retained security and management events, newest first.
          </p>
        </div>
        <span
          className={
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold " +
            (page.integrity.valid
              ? "bg-emerald-50 text-emerald-700"
              : "bg-red-50 text-red-700")
          }
        >
          {page.integrity.valid ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <ShieldAlert className="h-4 w-4" />
          )}
          Integrity: {page.integrity.valid ? "verified" : "failed"}
        </span>
      </div>

      {!page.integrity.valid && (
        <section className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <p className="font-semibold">
            The retained ledger failed verification.
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {page.integrity.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </section>
      )}

      <form className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:grid-cols-2 xl:grid-cols-7">
        <Input name="user" defaultValue={first(raw.user)} placeholder="User" />
        <Input name="site" defaultValue={first(raw.site)} placeholder="Site" />
        <Input
          name="action"
          defaultValue={first(raw.action)}
          placeholder="Action type"
        />
        <select
          name="result"
          defaultValue={first(raw.result) || ""}
          className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm"
        >
          <option value="">All outcomes</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
        </select>
        <Input
          type="date"
          name="from"
          defaultValue={first(raw.from)}
          aria-label="From date"
        />
        <Input
          type="date"
          name="to"
          defaultValue={first(raw.to)}
          aria-label="To date"
        />
        <div className="flex gap-2">
          <Button type="submit" className="flex-1">
            <Search className="h-4 w-4" /> Filter
          </Button>
          <Button asChild type="button" variant="outline">
            <Link href="/audit">Clear</Link>
          </Button>
        </div>
      </form>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold text-slate-800">
            {page.pagination.total} matching event
            {page.pagination.total === 1 ? "" : "s"}
          </p>
          <p className="text-xs text-slate-500">
            {page.integrity.checkedEvents} retained events checked
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-3 font-semibold">Time</th>
                <th className="px-5 py-3 font-semibold">User</th>
                <th className="px-5 py-3 font-semibold">Action</th>
                <th className="px-5 py-3 font-semibold">Site / target</th>
                <th className="px-5 py-3 font-semibold">Result</th>
                <th className="px-5 py-3 font-semibold">Context</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {page.events.map((event, index) => (
                <tr key={event.id} className="align-top">
                  <td className="whitespace-nowrap px-5 py-4 text-slate-500">
                    {new Date(event.timestamp).toLocaleString()}
                  </td>
                  <td className="px-5 py-4 font-medium text-slate-700">
                    {actor(event)}
                  </td>
                  <td className="px-5 py-4 font-mono text-xs text-slate-700">
                    {event.action}
                  </td>
                  <td className="max-w-56 break-all px-5 py-4 text-slate-600">
                    {target(event)}
                  </td>
                  <td className="px-5 py-4">
                    <span
                      className={
                        "rounded-full px-2.5 py-1 text-xs font-semibold " +
                        (event.result === "success"
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-red-50 text-red-700")
                      }
                    >
                      {event.result}
                    </span>
                  </td>
                  <td className="px-5 py-4">
                    {context[index] ? (
                      <details>
                        <summary className="cursor-pointer text-xs font-semibold text-panel-700">
                          View
                        </summary>
                        <pre className="mt-2 max-h-64 max-w-md overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-3 text-[11px] leading-5 text-slate-100">
                          {context[index]}
                        </pre>
                      </details>
                    ) : (
                      <span className="text-xs text-slate-400">None</span>
                    )}
                  </td>
                </tr>
              ))}
              {!page.events.length && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-5 py-12 text-center text-slate-500"
                  >
                    No audit events match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-slate-100 px-5 py-4">
          <p className="text-sm text-slate-500">
            Page {page.pagination.page} of {page.pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              asChild
              size="sm"
              variant="outline"
              disabled={page.pagination.page <= 1}
            >
              <Link
                href={pageHref(params, Math.max(1, page.pagination.page - 1))}
                aria-disabled={page.pagination.page <= 1}
              >
                <ChevronLeft className="h-4 w-4" /> Previous
              </Link>
            </Button>
            <Button
              asChild
              size="sm"
              variant="outline"
              disabled={page.pagination.page >= page.pagination.totalPages}
            >
              <Link
                href={pageHref(
                  params,
                  Math.min(
                    page.pagination.totalPages,
                    page.pagination.page + 1,
                  ),
                )}
                aria-disabled={
                  page.pagination.page >= page.pagination.totalPages
                }
              >
                Next <ChevronRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
