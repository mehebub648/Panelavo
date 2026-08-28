"use client";

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, Globe2, KeyRound, LoaderCircle, LockKeyhole, Settings2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { DatabaseExposure } from "@/types/cloudpanel";

export type DatabaseGatewaySummary = {
  ready?: boolean;
  suffix?: string;
  tlsTrust?: "public" | "panelavo-ca";
  caAvailable?: boolean;
  capacity?: number;
  active?: number;
};

export type DatabaseExposureItem = {
  id: string;
  name: string;
  users?: string[];
  exposure?: DatabaseExposure;
};

type Mode = "create" | "update" | "rotate" | "revoke";

function initialLabel(name: string) {
  const value = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return (value.length >= 3 ? value : `database-${value || "app"}`).slice(0, 40).replace(/-+$/g, "");
}

export function DatabaseExposureControls({
  domain,
  item,
  gateway,
}: {
  domain: string;
  item: DatabaseExposureItem;
  gateway: DatabaseGatewaySummary;
}) {
  const router = useRouter();
  const exposure = item.exposure ?? { status: "private" as const };
  const [mode, setMode] = useState<Mode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [label, setLabel] = useState(initialLabel(item.name));
  const [accessMode, setAccessMode] = useState<"allowlist" | "internet">(
    exposure.accessMode ?? "allowlist",
  );
  const [permissions, setPermissions] = useState<"ro" | "rw">(
    exposure.permissions ?? "ro",
  );
  const [allowlist, setAllowlist] = useState(
    (exposure.allowlist ?? []).join("\n"),
  );
  const [secret, setSecret] = useState<null | {
    hostname: string;
    port: number;
    username: string;
    password: string;
    tlsTrust: "public" | "panelavo-ca";
  }>(null);
  const hostname = useMemo(
    () =>
      mode === "create"
        ? `db-${label}.${gateway.suffix ?? ""}`.toLowerCase()
        : exposure.hostname ?? "",
    [exposure.hostname, gateway.suffix, label, mode],
  );

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mode || busy) return;
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const input: Record<string, unknown> = {
      action: `exposure-${mode}`,
      name: item.name,
      currentPassword: String(form.get("currentPassword") ?? ""),
      confirmation: String(form.get("confirmation") ?? "").toLowerCase(),
    };
    if (mode === "create") input.label = label;
    if (mode === "create" || mode === "update") {
      input.permissions = permissions;
      input.accessMode = accessMode;
      input.allowlist =
        accessMode === "allowlist"
          ? allowlist.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean)
          : [];
    }
    try {
      const response = await fetch(
        `/api/sites/${encodeURIComponent(domain)}/sections/databases`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      const result = await response.json();
      if (!result.success)
        throw new Error(result.error?.message || "The database endpoint could not be changed.");
      const endpoint = result.data?.endpoint as DatabaseExposure | undefined;
      const password = String(result.data?.password ?? "");
      if (password && endpoint?.hostname && endpoint.port && endpoint.username) {
        setSecret({
          hostname: endpoint.hostname,
          port: endpoint.port,
          username: endpoint.username,
          password,
          tlsTrust: endpoint.tlsTrust ?? "panelavo-ca",
        });
      }
      toast.success(mode === "revoke" ? "Database is private again" : "Database endpoint updated");
      setMode(null);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The operation failed.");
    } finally {
      setBusy(false);
    }
  }

  const isPublic = exposure.status !== "private";
  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${isPublic ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>
          {isPublic ? exposure.status : "Private"}
        </span>
        {!isPublic ? (
          <Button size="sm" variant="outline" disabled={!gateway.ready} onClick={() => setMode("create")}>
            <Globe2 className="h-4 w-4" /> Expose securely
          </Button>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={() => setMode("update")}><Settings2 className="h-4 w-4" /> Access</Button>
            <Button size="sm" variant="outline" onClick={() => setMode("rotate")}><KeyRound className="h-4 w-4" /> Rotate</Button>
            <Button size="sm" variant="outline" onClick={() => setMode("revoke")}><LockKeyhole className="h-4 w-4" /> Make private</Button>
          </>
        )}
      </div>
      {isPublic && exposure.hostname && exposure.port ? (
        <p className="mt-1 break-all text-right text-xs text-slate-500">
          {exposure.hostname}:{exposure.port}
          {exposure.tlsTrust === "panelavo-ca" ? (
            <>
              {" · "}
              <a
                className="font-semibold text-panel-600 underline"
                href="/api/server/database-gateway/ca"
              >
                Download CA
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {mode && createPortal(
        <div className="fixed inset-0 z-[90] flex items-center justify-center overflow-y-auto bg-slate-950/45 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setMode(null); }}>
          <form onSubmit={submit} className="my-auto w-full max-w-xl space-y-4 rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4"><div><h2 className="text-lg font-bold">{mode === "create" ? "Expose this database" : mode === "update" ? "Database endpoint access" : mode === "rotate" ? "Rotate endpoint password" : "Make database private"}</h2><p className="mt-1 text-sm text-slate-500">Only <b>{item.name}</b> is reachable through this endpoint. The main database service remains private.</p></div><Button type="button" variant="ghost" size="icon" disabled={busy} onClick={() => setMode(null)}><X className="h-5 w-5" /></Button></div>
            {mode === "create" && <div><Label>Endpoint label</Label><Input value={label} onChange={(event) => setLabel(event.target.value.toLowerCase())} pattern="(?!-)[a-z0-9-]{3,40}(?<!-)" required /><p className="mt-1 break-all text-xs text-slate-500">{hostname}</p></div>}
            {(mode === "create" || mode === "update") && <>
              <div><Label>Database permissions</Label><select className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm" value={permissions} onChange={(event) => setPermissions(event.target.value as "ro" | "rw")}><option value="ro">Read-only (recommended)</option><option value="rw">Read and write</option></select></div>
              <div><Label>Network access</Label><select className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm" value={accessMode} onChange={(event) => setAccessMode(event.target.value as "allowlist" | "internet")}><option value="allowlist">Only listed IP networks</option><option value="internet">Internet-wide</option></select></div>
              {accessMode === "allowlist" ? <div><Label>Allowed IP addresses or CIDRs</Label><textarea className="mt-1 min-h-24 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" value={allowlist} onChange={(event) => setAllowlist(event.target.value)} placeholder="203.0.113.10/32&#10;2001:db8::/64" required /></div> : <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Anyone can reach the port and attempt authentication. A generated password, TLS, connection limits, and database-only grants still apply.</div>}
            </>}
            <div><Label>Current Panelavo password</Label><Input name="currentPassword" type="password" autoComplete="current-password" required /></div>
            <div><Label>Type the endpoint hostname exactly</Label><Input name="confirmation" autoComplete="off" placeholder={hostname} required /><p className="mt-1 break-all text-xs text-slate-500">{hostname}</p></div>
            {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
            <Button disabled={busy || !hostname}>{busy && <LoaderCircle className="h-4 w-4 animate-spin" />}{mode === "revoke" ? "Close endpoint and revoke credential" : mode === "rotate" ? "Rotate and show password once" : "Apply endpoint settings"}</Button>
          </form>
        </div>, document.body)}
      {secret && createPortal(
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm"><div className="w-full max-w-xl space-y-4 rounded-2xl bg-white p-6 shadow-2xl"><div className="flex items-start justify-between"><div><h2 className="text-lg font-bold">Save this password now</h2><p className="text-sm text-slate-500">It will not be shown again.</p></div><Button variant="ghost" size="icon" onClick={() => setSecret(null)}><X className="h-5 w-5" /></Button></div>{[["Host", secret.hostname], ["Port", String(secret.port)], ["Database", item.name], ["User", secret.username], ["Password", secret.password]].map(([key, value]) => <div key={key}><Label>{key}</Label><div className="mt-1 flex gap-2"><code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-slate-950 p-3 text-sm text-slate-100">{value}</code><Button variant="outline" size="icon" onClick={() => { void navigator.clipboard.writeText(value); toast.success(`${key} copied`); }}><Copy className="h-4 w-4" /></Button></div></div>)}{secret.tlsTrust === "panelavo-ca" && <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">Install the Panelavo CA on this database client and enable hostname verification. <a className="font-bold underline" href="/api/server/database-gateway/ca">Download CA certificate</a>.</div>}<Button onClick={() => setSecret(null)}>I saved the credential</Button></div></div>, document.body)}
    </>
  );
}
