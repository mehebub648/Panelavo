"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, LoaderCircle, Save, Trash2 } from "lucide-react";
import type { CloudPanelSite, CloudPanelUser } from "@/types/cloudpanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SiteSettings({
  initialSite,
  user,
}: {
  initialSite: CloudPanelSite;
  user: CloudPanelUser;
}) {
  const router = useRouter();
  const [site, setSite] = useState(initialSite);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    const data = new FormData(event.currentTarget);
    const body: Record<string, string | number> = {
      rootDirectory: String(data.get("rootDirectory") ?? ""),
    };
    if (["php", "nodejs", "python"].includes(site.type ?? ""))
      body.runtimeVersion = String(data.get("runtimeVersion") ?? "");
    if (["nodejs", "python"].includes(site.type ?? ""))
      body.appPort = Number(data.get("appPort"));
    if (site.type === "reverse-proxy")
      body.reverseProxyUrl = String(data.get("reverseProxyUrl") ?? "");
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(site.domain)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error?.message || "Update failed.");
      setSite(result.data.site);
      setSaved(true);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Permanently delete ${site.domain} and its files?`)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(site.domain)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error?.message || "Deletion failed.");
      router.replace("/sites");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Deletion failed.");
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link href="/sites" className="inline-flex items-center gap-2 text-sm font-semibold text-slate-500 hover:text-slate-900">
        <ArrowLeft className="h-4 w-4" /> Back to websites
      </Link>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink">{site.domain}</h1>
          <p className="mt-1 text-sm text-slate-500">{site.application || site.type} · {site.siteUser}</p>
        </div>
        <Button asChild variant="outline">
          <a href={site.url} target="_blank" rel="noreferrer">Open site <ExternalLink className="h-4 w-4" /></a>
        </Button>
      </div>
      <form onSubmit={save} className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-card">
        <div>
          <h2 className="text-lg font-bold">Website settings</h2>
          <p className="mt-1 text-sm text-slate-500">Changes are applied through CloudPanel and reload NGINX automatically.</p>
        </div>
        <div>
          <Label htmlFor="rootDirectory">Root directory</Label>
          <Input id="rootDirectory" name="rootDirectory" defaultValue={site.rootDirectory} disabled={!user.canCreateSites} />
        </div>
        {["php", "nodejs", "python"].includes(site.type ?? "") && (
          <div>
            <Label htmlFor="runtimeVersion">Runtime version</Label>
            <Input id="runtimeVersion" name="runtimeVersion" defaultValue={site.runtimeVersion} disabled={!user.canCreateSites} />
          </div>
        )}
        {["nodejs", "python"].includes(site.type ?? "") && (
          <div>
            <Label htmlFor="appPort">Application port</Label>
            <Input id="appPort" name="appPort" type="number" min={1024} max={65535} defaultValue={site.appPort} disabled={!user.canCreateSites} />
          </div>
        )}
        {site.type === "reverse-proxy" && (
          <div>
            <Label htmlFor="reverseProxyUrl">Reverse proxy URL</Label>
            <Input id="reverseProxyUrl" name="reverseProxyUrl" defaultValue={site.reverseProxyUrl} disabled={!user.canCreateSites} />
          </div>
        )}
        {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        {saved && <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">Website settings saved.</p>}
        {user.canCreateSites && (
          <div className="flex justify-end">
            <Button type="submit" disabled={busy}>
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save changes
            </Button>
          </div>
        )}
      </form>
      {user.canCreateSites && (
        <section className="rounded-2xl border border-red-200 bg-white p-6">
          <h2 className="font-bold text-red-700">Danger zone</h2>
          <p className="mt-1 text-sm text-slate-500">Delete this website, configuration, databases, and files from CloudPanel.</p>
          <Button type="button" variant="danger" className="mt-4" onClick={remove} disabled={busy}>
            <Trash2 className="h-4 w-4" /> Delete website
          </Button>
        </section>
      )}
    </div>
  );
}
