"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LoaderCircle, Save, Trash2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import type { CloudPanelSite, CloudPanelUser, SiteCreationOptions } from "@/types/cloudpanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";


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
  const [confirmAction, setConfirmAction] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);


  const [options, setOptions] = useState<SiteCreationOptions | null>(null);

  const hasRuntime = ["php", "nodejs", "python"].includes(site.type ?? "");
  // The stored value can be verbose ("Node.js 22"); the dropdown works with
  // the bare version CloudPanel expects.
  const currentRuntime = (site.runtimeVersion ?? "").replace(/^[^\d]*/, "");
  const runtimeVersions =
    site.type === "php"
      ? options?.phpVersions
      : site.type === "nodejs"
        ? options?.nodeVersions
        : site.type === "python"
          ? options?.pythonVersions
          : undefined;
  const runtimeChoices = runtimeVersions
    ? runtimeVersions.includes(currentRuntime) || !currentRuntime
      ? runtimeVersions
      : [currentRuntime, ...runtimeVersions]
    : null;

  useEffect(() => {
    if (!hasRuntime || !user.canCreateSites) return;
    fetch("/api/sites/options", { cache: "no-store" })
      .then((response) => response.json())
      .then((result) => {
        if (result.success) setOptions(result.data.options as SiteCreationOptions);
      })
      .catch(() => undefined);
  }, [hasRuntime, user.canCreateSites]);

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
    if (site.type === "reverse-proxy" || site.type === "docker")
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

  function remove() {
    setConfirmAction({
      title: "Delete website",
      message: `Permanently delete ${site.domain} and its files? This action cannot be undone.`,
      onConfirm: async () => {
        setConfirmAction(null);
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
    });
  }


  return (
    <div className="w-full space-y-5">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-ink drop-shadow-sm">Settings</h2>
        <p className="mt-1 text-sm text-slate-500">
          {site.application || site.type} · Site user:{" "}
          {site.siteUser || "not available"}
        </p>
      </div>

      {site.meta?.parent && (
        <div className="rounded-xl border border-panel-200/60 bg-panel-50/40 p-4 text-sm text-slate-600">
          This website is a linked service
          {site.meta.serviceName ? (
            <> (<span className="font-semibold">{site.meta.serviceName}</span>)</>
          ) : null}{" "}
          of{" "}
          <Link
            href={`/sites/${encodeURIComponent(site.meta.parent)}/settings`}
            className="font-semibold text-panel-700 hover:underline"
          >
            {site.meta.parent}
          </Link>
          . It proxies one port of that website&apos;s stack — files, databases,
          and operations are managed on the parent.
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200/60 bg-red-50/40 p-4 text-sm text-red-600 animate-in fade-in zoom-in-95">
          <div className="flex items-center gap-2 font-bold"><AlertTriangle className="h-4 w-4" /> Error</div>
          <div className="mt-1">{error}</div>
        </div>
      )}

      <form
        ref={formRef}
        onSubmit={save}
        className="overflow-hidden rounded-2xl border border-white/40 bg-white/60 backdrop-blur-md shadow-card transition-all hover:shadow-card-hover animate-fade-in"
      >
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200/50 bg-slate-50/40 px-5 py-4 sm:px-6">
          <div>
            <h3 className="font-bold">Website configuration</h3>
            <p className="mt-1 text-sm text-slate-500">
              Saving reloads NGINX automatically.
            </p>
          </div>
          {user.canCreateSites && (
            <kbd className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-500 shadow-sm flex items-center gap-1">
              <span className="opacity-70">Ctrl/⌘</span> <span>S</span>
            </kbd>
          )}
        </div>
        <div className="grid gap-5 p-5 sm:grid-cols-2 sm:p-6">
          <div>
            <Label htmlFor="rootDirectory" className="font-medium text-slate-700">Root directory</Label>
            <Input
              id="rootDirectory"
              name="rootDirectory"
              defaultValue={site.rootDirectory}
              disabled={!user.canCreateSites}
              className="mt-1.5 transition-all focus:ring-2 focus:ring-panel-500/50 bg-white/70"
            />
          </div>
          {hasRuntime && (
            <div>
              <Label htmlFor="runtimeVersion" className="font-medium text-slate-700">Runtime version</Label>
              {runtimeChoices ? (
                <Select
                  id="runtimeVersion"
                  name="runtimeVersion"
                  defaultValue={currentRuntime || runtimeChoices[0]}
                  disabled={!user.canCreateSites}
                  className="mt-1.5 bg-white/70"
                >
                  {runtimeChoices.map((version) => (
                    <option key={version} value={version}>
                      {site.type === "php" ? "PHP" : site.type === "nodejs" ? "Node.js" : "Python"} {version}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  id="runtimeVersion"
                  name="runtimeVersion"
                  defaultValue={currentRuntime || site.runtimeVersion}
                  disabled={!user.canCreateSites}
                  className="mt-1.5 transition-all focus:ring-2 focus:ring-panel-500/50 bg-white/70"
                />
              )}
            </div>
          )}
          {["nodejs", "python"].includes(site.type ?? "") && (
            <div>
              <Label htmlFor="appPort" className="font-medium text-slate-700">Application port</Label>
              <Input
                id="appPort"
                name="appPort"
                type="number"
                min={1024}
                max={65535}
                defaultValue={site.appPort}
                disabled={!user.canCreateSites}
                className="mt-1.5 transition-all focus:ring-2 focus:ring-panel-500/50 bg-white/70"
              />
              <p className="mt-1.5 text-xs text-slate-400">
                For panel-created sites the port is the reserved site id — pick a
                free port inside a category range (20000–29999) to move the
                reservation. The system domain keeps its original id.
              </p>
            </div>
          )}
          {(site.type === "reverse-proxy" || site.type === "docker") && (
            <div>
              <Label htmlFor="reverseProxyUrl" className="font-medium text-slate-700">
                {site.type === "docker" ? "Container URL" : "Reverse proxy URL"}
              </Label>
              <Input
                id="reverseProxyUrl"
                name="reverseProxyUrl"
                defaultValue={site.reverseProxyUrl}
                disabled={!user.canCreateSites}
                className="mt-1.5 transition-all focus:ring-2 focus:ring-panel-500/50 bg-white/70"
              />
              {site.type === "docker" && (
                <p className="mt-1.5 text-xs text-slate-400">
                  Traffic is proxied to this address — usually the published port of your container.
                </p>
              )}
            </div>
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
          <div className="flex justify-end border-t border-slate-200/50 bg-slate-50/40 px-5 py-4 sm:px-6">
            <Button type="submit" disabled={busy} className="shadow-sm hover:shadow transition-all duration-200 hover:-translate-y-0.5">
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
        <section className="flex flex-col gap-4 rounded-2xl border border-red-200/60 bg-gradient-to-br from-red-50/50 to-white/50 backdrop-blur-sm p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6 shadow-sm">
          <div>
            <h3 className="font-bold text-red-700">
              {site.meta?.parent ? "Delete linked service" : "Delete website"}
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              {site.meta?.parent
                ? "Removes this service's domain and proxy configuration. The parent website is not affected."
                : "Permanently removes its configuration, databases, and files."}
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

      {confirmAction && (
        <ConfirmDialog
          title={confirmAction.title}
          message={confirmAction.message}
          onConfirm={confirmAction.onConfirm}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  );
}
