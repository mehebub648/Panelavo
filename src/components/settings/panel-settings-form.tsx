"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  Globe2,
  LoaderCircle,
  RefreshCw,
  Save,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Settings = {
  baseDomain: string;
};
type DnsStatus = { name: string; ip: string | null; ips: string[]; pointed: boolean } | null;
type Category = { id: string; label: string; start: number; end: number };

export function PanelSettingsForm({
  initialSettings,
  initialDns,
  wildcardDomain,
  serverIp,
  categories,
}: {
  initialSettings: Settings;
  initialDns: DnsStatus;
  wildcardDomain: string;
  serverIp: string;
  categories: Category[];
}) {
  const router = useRouter();
  const [dns, setDns] = useState<DnsStatus>(initialDns);
  const [wildcard, setWildcard] = useState(wildcardDomain);
  const [baseDomain, setBaseDomain] = useState(initialSettings.baseDomain);
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
      setBaseDomain(result.data.settings.baseDomain);
      setDns(result.data.dns);
      setWildcard(result.data.wildcardDomain);
      toast.success(success);
      router.refresh();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Settings could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  // The base-domain subdomain wildcard is registered/verified through the same
  // /api/setup endpoint used by the onboarding screen; auto-registration is only
  // available for the ippointer-managed mehebub.com zone.
  const canAutoRegister = baseDomain.trim().toLowerCase() === "mehebub.com";

  function applyStatus(status: {
    wildcardDomain: string;
    pointed: boolean;
    probeName: string;
    resolvedIps: string[];
  }) {
    setWildcard(status.wildcardDomain);
    setDns({
      name: status.probeName,
      ip: status.resolvedIps[0] ?? null,
      ips: status.resolvedIps,
      pointed: status.pointed,
    });
    router.refresh();
  }

  async function setup(
    method: "GET" | "POST",
    body: Record<string, unknown> | null,
    onDone: (data: {
      status: Parameters<typeof applyStatus>[0];
      register?: { ok: boolean; error?: string };
    }) => void,
  ) {
    setBusy(true);
    try {
      const response = await fetch("/api/setup", {
        method,
        headers: body
          ? { "content-type": "application/json" }
          : { "cache-control": "no-store" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const result = await response.json();
      if (!result.success)
        throw new Error(result.error?.message || "Request failed.");
      applyStatus(result.data.status);
      onDone(result.data);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  const recheckWildcard = () =>
    setup("GET", null, (data) =>
      data.status.pointed
        ? toast.success("Wildcard resolves here")
        : toast.info("Still not resolving here yet"),
    );

  const registerWildcard = () =>
    setup("POST", { action: "register" }, (data) =>
      data.register && !data.register.ok
        ? toast.error(data.register.error || "Registration failed.")
        : toast.success("Wildcard registered"),
    );

  const preview = `site-20001.${serverIp || "<server-ip>"}.${baseDomain || "example.com"}`;
  const shownWildcard =
    wildcard || `*.${serverIp || "<server-ip>"}.${baseDomain || "example.com"}`;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-ink">Panel settings</h2>
        <p className="mt-1 text-sm text-slate-500">
          Base domain, wildcard DNS, and site id ranges used when creating websites.
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
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm">
            <p className="font-semibold text-slate-800">Required wildcard DNS</p>
            <p className="mt-1 text-slate-500">
              Create one DNS A record pointing <b className="break-all">{shownWildcard}</b>{" "}
              to <b>{serverIp || "this server"}</b>.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {dns?.pointed ? (
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 font-medium text-emerald-700">
                  <CheckCircle2 className="h-4 w-4" /> Wildcard resolves here
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 font-medium text-amber-700">
                  <TriangleAlert className="h-4 w-4" />
                  {dns?.ip ? `Probe points to ${dns.ip}` : "Wildcard probe does not resolve here"}
                </span>
              )}
              {dns?.name && (
                <span className="break-all text-xs text-slate-400">
                  Checked {dns.name}
                </span>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {canAutoRegister ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={registerWildcard}
                >
                  <Zap className="h-4 w-4" /> Auto-register
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setBaseDomain("mehebub.com");
                    void patch({ baseDomain: "mehebub.com" }, "Base domain saved");
                  }}
                >
                  Use default mehebub.com domain
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={recheckWildcard}
              >
                <RefreshCw className="h-4 w-4" /> Recheck
              </Button>
            </div>
          </div>
        </div>
        <div className="flex justify-end border-t border-slate-100 bg-slate-50/60 px-5 py-4 sm:px-6">
          <Button type="submit" disabled={busy || !baseDomain.trim()}>
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save base domain
          </Button>
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
