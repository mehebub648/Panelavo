"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  Cloud,
  Globe2,
  KeyRound,
  LoaderCircle,
  Save,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Settings = {
  baseDomain: string;
  cloudflare: { configured: boolean; updatedAt?: string };
};
type Zone = { id: string; name: string } | null;
type Category = { id: string; label: string; start: number; end: number };

export function PanelSettingsForm({
  initialSettings,
  initialZone,
  serverIp,
  categories,
}: {
  initialSettings: Settings;
  initialZone: Zone;
  serverIp: string;
  categories: Category[];
}) {
  const router = useRouter();
  const [settings, setSettings] = useState(initialSettings);
  const [zone, setZone] = useState<Zone>(initialZone);
  const [baseDomain, setBaseDomain] = useState(initialSettings.baseDomain);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  async function patch(body: Record<string, unknown>, success: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!result.success)
        throw new Error(result.error?.message || "Settings could not be saved.");
      setSettings(result.data.settings);
      setZone(result.data.zone);
      setBaseDomain(result.data.settings.baseDomain);
      setToken("");
      toast.success(success);
      router.refresh();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Settings could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const preview = `site-20001.${serverIp || "<server-ip>"}.${baseDomain || "example.com"}`;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-ink">Panel settings</h2>
        <p className="mt-1 text-sm text-slate-500">
          Base domain, automatic DNS, and site id ranges used when creating websites.
        </p>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void patch({ baseDomain }, "Base domain saved");
        }}
        className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card"
      >
        <div className="flex items-center gap-3 border-b border-slate-100 bg-slate-50/60 px-5 py-4 sm:px-6">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-panel-50 text-panel-600">
            <Globe2 className="h-5 w-5" />
          </span>
          <div>
            <h3 className="font-bold">Base domain</h3>
            <p className="text-sm text-slate-500">
              Every new website gets a system subdomain under this domain.
            </p>
          </div>
        </div>
        <div className="space-y-4 p-5 sm:p-6">
          <div>
            <Label htmlFor="baseDomain">Base domain</Label>
            <Input
              id="baseDomain"
              value={baseDomain}
              onChange={(event) => setBaseDomain(event.target.value.toLowerCase())}
              placeholder="example.com"
              required
            />
          </div>
          <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm">
            <span className="text-slate-500">New sites will look like:</span>{" "}
            <b className="break-all">{preview}</b>
            <p className="mt-1 text-xs text-slate-500">
              Changing the base domain affects websites created from now on; existing
              websites keep the domain they were created with.
            </p>
          </div>
        </div>
        <div className="flex justify-end border-t border-slate-100 bg-slate-50/60 px-5 py-4 sm:px-6">
          <Button type="submit" disabled={busy || !baseDomain.trim()}>
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save base domain
          </Button>
        </div>
      </form>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (token.trim()) void patch({ cloudflareToken: token.trim() }, "Cloudflare token saved");
        }}
        className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card"
      >
        <div className="flex items-center gap-3 border-b border-slate-100 bg-slate-50/60 px-5 py-4 sm:px-6">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-amber-50 text-amber-600">
            <Cloud className="h-5 w-5" />
          </span>
          <div>
            <h3 className="font-bold">Cloudflare DNS automation</h3>
            <p className="text-sm text-slate-500">
              An API token with DNS edit access to the base domain lets the panel point
              new subdomains (and matching customer domains) at this server automatically.
            </p>
          </div>
        </div>
        <div className="space-y-4 p-5 sm:p-6">
          {settings.cloudflare.configured ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm">
              <span className="flex items-center gap-2 font-medium text-emerald-700">
                <CheckCircle2 className="h-5 w-5" />
                Token configured
                {settings.cloudflare.updatedAt &&
                  ` · ${new Date(settings.cloudflare.updatedAt).toLocaleDateString()}`}
                {zone ? ` · manages ${zone.name}` : ""}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void patch({ clearCloudflareToken: true }, "Cloudflare token removed")}
              >
                <Trash2 className="h-4 w-4" /> Remove token
              </Button>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              No token configured — DNS records for new websites must be created manually.
            </div>
          )}
          {settings.cloudflare.configured && baseDomain && !zone && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              The token does not manage a zone covering <b className="mx-1">{baseDomain}</b> —
              automatic DNS for system subdomains will not work.
            </div>
          )}
          <div>
            <Label htmlFor="cfToken">
              {settings.cloudflare.configured ? "Replace API token" : "Cloudflare API token"}
            </Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  id="cfToken"
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="Paste a token with Zone → DNS → Edit permission"
                  autoComplete="off"
                  className="pl-9"
                />
              </div>
              <Button type="submit" disabled={busy || !token.trim()}>
                {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save token
              </Button>
            </div>
          </div>
        </div>
      </form>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
        <div className="border-b border-slate-100 bg-slate-50/60 px-5 py-4 sm:px-6">
          <h3 className="font-bold">Site id &amp; port ranges</h3>
          <p className="text-sm text-slate-500">
            Each website reserves one id from its category; the id is also the
            application port and the site user name (site-&lt;id&gt;).
          </p>
        </div>
        <div className="divide-y divide-slate-100 text-sm">
          {categories.map((category) => (
            <div key={category.id} className="flex items-center justify-between px-5 py-3 sm:px-6">
              <span className="font-medium text-slate-700">{category.label}</span>
              <span className="font-mono text-slate-500">
                {category.start}–{category.end}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
