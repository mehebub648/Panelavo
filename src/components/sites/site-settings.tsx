"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
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
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        formRef.current?.requestSubmit();
      }
    }
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, []);

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
      const response = await fetch(
        `/api/sites/${encodeURIComponent(site.domain)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const result = await response.json();
      if (!result.success)
        throw new Error(result.error?.message || "Update failed.");
      setSite(result.data.site);
      setSaved(true);
      toast.success("Website settings saved");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Permanently delete ${site.domain} and its files?`))
      return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/sites/${encodeURIComponent(site.domain)}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      const result = await response.json();
      if (!result.success)
        throw new Error(result.error?.message || "Deletion failed.");
      router.replace("/sites");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Deletion failed.");
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-ink">Settings</h2>
        <p className="mt-1 text-sm text-slate-500">
          {site.application || site.type} · Site user:{" "}
          {site.siteUser || "not available"}
        </p>
      </div>
      <form
        ref={formRef}
        onSubmit={save}
        className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card"
      >
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 bg-slate-50/60 px-5 py-4 sm:px-6">
          <div>
            <h3 className="font-bold">Website configuration</h3>
            <p className="mt-1 text-sm text-slate-500">
              Saving reloads NGINX automatically.
            </p>
          </div>
          {user.canCreateSites && (
            <kbd className="rounded-md border bg-white px-2 py-1 text-xs text-slate-500">
              Ctrl/⌘ + S
            </kbd>
          )}
        </div>
        <div className="grid gap-5 p-5 sm:grid-cols-2 sm:p-6">
          <div>
            <Label htmlFor="rootDirectory">Root directory</Label>
            <Input
              id="rootDirectory"
              name="rootDirectory"
              defaultValue={site.rootDirectory}
              disabled={!user.canCreateSites}
            />
          </div>
          {["php", "nodejs", "python"].includes(site.type ?? "") && (
            <div>
              <Label htmlFor="runtimeVersion">Runtime version</Label>
              <Input
                id="runtimeVersion"
                name="runtimeVersion"
                defaultValue={site.runtimeVersion}
                disabled={!user.canCreateSites}
              />
            </div>
          )}
          {["nodejs", "python"].includes(site.type ?? "") && (
            <div>
              <Label htmlFor="appPort">Application port</Label>
              <Input
                id="appPort"
                name="appPort"
                type="number"
                min={1024}
                max={65535}
                defaultValue={site.appPort}
                disabled={!user.canCreateSites}
              />
            </div>
          )}
          {site.type === "reverse-proxy" && (
            <div>
              <Label htmlFor="reverseProxyUrl">Reverse proxy URL</Label>
              <Input
                id="reverseProxyUrl"
                name="reverseProxyUrl"
                defaultValue={site.reverseProxyUrl}
                disabled={!user.canCreateSites}
              />
            </div>
          )}
          {error && (
            <p
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 sm:col-span-2"
            >
              {error}
            </p>
          )}
          {saved && (
            <p
              role="status"
              className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700 sm:col-span-2"
            >
              Website settings saved.
            </p>
          )}
        </div>
        {user.canCreateSites && (
          <div className="flex justify-end border-t border-slate-100 bg-slate-50/60 px-5 py-4 sm:px-6">
            <Button type="submit" disabled={busy}>
              {busy ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}{" "}
              Save changes
            </Button>
          </div>
        )}
      </form>
      {user.canCreateSites && (
        <section className="flex flex-col gap-4 rounded-2xl border border-red-200 bg-red-50/40 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div>
            <h3 className="font-bold text-red-700">Delete website</h3>
            <p className="mt-1 text-sm text-slate-600">
              Permanently removes its configuration, databases, and files.
            </p>
          </div>
          <Button
            type="button"
            variant="danger"
            className="shrink-0"
            onClick={remove}
            disabled={busy}
          >
            <Trash2 className="h-4 w-4" /> Delete website
          </Button>
        </section>
      )}
    </div>
  );
}
