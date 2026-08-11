"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Globe2, LoaderCircle, RefreshCw, Save, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SystemStatus } from "@/server/network/system-status";
import type { AddressMode } from "@/server/settings/store";

export function SetupView({ status: initialStatus, isSuperAdmin, reconfiguring = false }: {
  status: SystemStatus;
  isSuperAdmin: boolean;
  reconfiguring?: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [addressMode, setAddressMode] = useState<AddressMode>(initialStatus.addressMode);
  const [baseDomain, setBaseDomain] = useState(initialStatus.addressMode === "custom" ? initialStatus.baseDomain : "");
  const [busy, setBusy] = useState<null | "save" | "recheck">(null);

  function apply(next: SystemStatus, message?: string) {
    setStatus(next);
    setAddressMode(next.addressMode);
    if (next.addressMode === "custom") setBaseDomain(next.baseDomain);
    if (next.ready) {
      if (message) toast.success(message);
      router.replace(reconfiguring ? "/settings" : "/sites");
      router.refresh();
    }
  }

  async function call(kind: "save" | "recheck", run: () => Promise<Response>, message?: string) {
    setBusy(kind);
    try {
      const result = await (await run()).json();
      if (!result.success) throw new Error(result.error?.message || "Request failed.");
      apply(result.data.status, message);
      if (kind === "recheck" && !result.data.status.ready) toast.info("DNS is not ready yet.");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Request failed.");
    } finally {
      setBusy(null);
    }
  }

  const save = () => call("save", () => fetch("/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "configure-address",
      addressMode,
      ...(addressMode === "custom" ? { baseDomain } : {}),
    }),
  }), addressMode === "sslip" ? "sslip.io address configured" : "Custom domain saved and DNS is live");
  const recheck = () => call("recheck", () => fetch("/api/setup", { headers: { "cache-control": "no-store" } }), "DNS is live");

  const ip = status.serverIp || "<server-ip>";
  const effectiveBase = addressMode === "sslip" ? "sslip.io" : baseDomain || "example.com";
  const wildcard = `*.${ip}.${effectiveBase}`;

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <div className="flex items-center justify-between">
          <Brand />
          <span className="rounded-full border border-panel-100 bg-panel-50 px-3 py-1 text-xs font-semibold text-panel-700">
            {reconfiguring ? "Reconfigure" : "Setup required"}
          </span>
        </div>
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
          <div className="flex items-center gap-3 border-b border-slate-100 bg-slate-50/60 px-6 py-5">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-panel-50 text-panel-600"><Globe2 className="h-5 w-5" /></span>
            <div>
              <h1 className="text-lg font-bold text-ink">{reconfiguring ? "Change installation address" : "Finish panel setup"}</h1>
              <p className="text-sm text-slate-500">Choose how Panelavo and generated website hostnames resolve to this server.</p>
            </div>
          </div>
          <div className="space-y-5 p-6">
            <div className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm ${status.pointed ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
              {status.pointed ? <><CheckCircle2 className="h-4 w-4" /> Address resolves to this server.</> : <><TriangleAlert className="h-4 w-4" /> {status.reason}</>}
            </div>
            {isSuperAdmin ? <>
              <fieldset className="space-y-3">
                <legend className="text-sm font-semibold text-slate-700">Installation address</legend>
                <label className={`block cursor-pointer rounded-xl border p-4 ${addressMode === "sslip" ? "border-panel-400 bg-panel-50/50" : "border-slate-200"}`}>
                  <input type="radio" name="addressMode" value="sslip" checked={addressMode === "sslip"} onChange={() => setAddressMode("sslip")} className="mr-2" />
                  <b>sslip.io — Recommended</b>
                  <p className="mt-1 pl-6 text-xs text-slate-500">No DNS record to create. Uses panel.{ip}.sslip.io, database.{ip}.sslip.io, and site-&lt;id&gt;.{ip}.sslip.io.</p>
                </label>
                <label className={`block cursor-pointer rounded-xl border p-4 ${addressMode === "custom" ? "border-panel-400 bg-panel-50/50" : "border-slate-200"}`}>
                  <input type="radio" name="addressMode" value="custom" checked={addressMode === "custom"} onChange={() => setAddressMode("custom")} className="mr-2" />
                  <b>Custom domain</b>
                  <p className="mt-1 pl-6 text-xs text-slate-500">Use a domain you control and create one wildcard A record.</p>
                </label>
              </fieldset>
              {addressMode === "custom" && <div className="space-y-2">
                <Label htmlFor="baseDomain">Base domain</Label>
                <Input id="baseDomain" value={baseDomain} onChange={(event) => setBaseDomain(event.target.value.toLowerCase())} placeholder="example.com" />
                <div className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600"><b>Required A record:</b> <code className="break-all">{wildcard}</code> → <b>{ip}</b></div>
              </div>}
              {addressMode === "sslip" && <div className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">Generated hostnames are verified directly. Individual HTTP-01 certificates are issued; wildcard certificates are not used.</div>}
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="ghost" disabled={busy !== null} onClick={recheck}>{busy === "recheck" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Recheck DNS</Button>
                <Button type="button" disabled={busy !== null || (addressMode === "custom" && !baseDomain.trim())} onClick={save}>{busy === "save" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save</Button>
              </div>
            </> : <p className="text-sm text-slate-600">A super administrator needs to finish the installation address setup.</p>}
          </div>
        </div>
        {reconfiguring && <div className="text-center"><Link href="/settings" className="text-sm font-medium text-slate-500 hover:text-slate-700">← Back to settings</Link></div>}
      </div>
    </main>
  );
}
