"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ExternalLink,
  LoaderCircle,
  Network,
  Plus,
  Settings,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type LinkedService = {
  domain: string;
  serviceName: string;
  aliases: string[];
  reverseProxyUrl?: string;
  status?: string;
  accessible: boolean;
};

// Groups the reverse-proxy sites that expose additional ports of this
// website's stack (api.app.com, auth.app.com, …). Each service is a real
// CloudPanel site — this section only creates and lists them in one place.
export function LinkedServices({
  parentDomain,
  canWrite,
}: {
  parentDomain: string;
  canWrite: boolean;
}) {
  const [services, setServices] = useState<LinkedService[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/sites/${encodeURIComponent(parentDomain)}/services`,
        { cache: "no-store" },
      );
      const result = await response.json();
      if (result.success) setServices(result.data.services);
      else setServices([]);
    } catch {
      setServices([]);
    }
  }, [parentDomain]);
  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    const alias = String(data.get("alias") ?? "").trim();
    try {
      const response = await fetch(
        `/api/sites/${encodeURIComponent(parentDomain)}/services`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            serviceName: String(data.get("serviceName") ?? ""),
            targetPort: Number(data.get("targetPort")),
            aliases: alias ? [alias] : [],
          }),
        },
      );
      const result = await response.json();
      if (!result.success)
        throw new Error(
          result.error?.message || "The service could not be created.",
        );
      toast.success("Linked service created");
      for (const warning of result.data.warnings ?? [])
        toast.warning(warning);
      setShowForm(false);
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The service could not be created.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-white/40 bg-white/60 shadow-card backdrop-blur-md">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200/50 bg-slate-50/40 px-5 py-4 sm:px-6">
        <div>
          <h3 className="font-bold">Linked services</h3>
          <p className="mt-1 text-sm text-slate-500">
            Expose another port of this website&apos;s stack — such as an API or
            auth service — on its own domain. Each service is created as a
            reverse-proxy website and managed from here.
          </p>
        </div>
        {canWrite && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setError("");
              setShowForm((value) => !value);
            }}
          >
            <Plus className="h-4 w-4" /> Add service
          </Button>
        )}
      </div>

      {showForm && canWrite && (
        <form
          onSubmit={create}
          className="grid gap-4 border-b border-slate-100 bg-panel-50/30 p-5 sm:grid-cols-3 sm:p-6"
        >
          <div>
            <Label htmlFor="serviceName">Service name</Label>
            <Input
              id="serviceName"
              name="serviceName"
              required
              maxLength={32}
              pattern="[a-zA-Z][a-zA-Z0-9-]*"
              placeholder="api"
              className="mt-1.5 bg-white/70"
            />
          </div>
          <div>
            <Label htmlFor="targetPort">Target port</Label>
            <Input
              id="targetPort"
              name="targetPort"
              type="number"
              required
              min={1024}
              max={65535}
              placeholder="20001"
              className="mt-1.5 bg-white/70"
            />
            <p className="mt-1.5 text-xs text-slate-400">
              A loopback port this website&apos;s own stack exposes — the
              Operations preflight lists additional published ports.
            </p>
          </div>
          <div>
            <Label htmlFor="alias">Custom domain (optional)</Label>
            <Input
              id="alias"
              name="alias"
              placeholder="api.example.com"
              className="mt-1.5 bg-white/70"
            />
            <p className="mt-1.5 text-xs text-slate-400">
              More domains can be added later from the service&apos;s Domains
              tab.
            </p>
          </div>
          {error && (
            <p className="text-sm text-red-600 sm:col-span-3">{error}</p>
          )}
          <div className="flex justify-end gap-2 sm:col-span-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setShowForm(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}{" "}
              Create service
            </Button>
          </div>
        </form>
      )}

      {services === null ? (
        <div className="p-5 sm:p-6">
          <div className="h-12 animate-pulse rounded-xl bg-slate-100" />
        </div>
      ) : services.length === 0 ? (
        <p className="p-5 text-sm text-slate-500 sm:p-6">
          No linked services yet.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {services.map((service) => (
            <li
              key={service.domain}
              className="flex flex-wrap items-center gap-3 px-5 py-4 sm:px-6"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-rose-50 text-rose-600">
                <Network className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-slate-800">
                  {service.serviceName}
                </p>
                <p className="mt-0.5 truncate text-xs text-slate-400">
                  {service.aliases[0] || service.domain}
                  {service.reverseProxyUrl && (
                    <>
                      <span className="mx-1.5 opacity-50">•</span>
                      {service.reverseProxyUrl}
                    </>
                  )}
                </p>
              </div>
              {service.accessible ? (
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" asChild>
                    <Link
                      href={`/sites/${encodeURIComponent(service.domain)}/settings`}
                      aria-label={`Manage ${service.serviceName}`}
                    >
                      <Settings className="h-4 w-4" />
                    </Link>
                  </Button>
                  <Button variant="ghost" size="icon" asChild>
                    <a
                      href={`https://${service.aliases[0] || service.domain}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Open ${service.serviceName}`}
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </Button>
                </div>
              ) : (
                <span className="text-xs text-slate-400">
                  Not assigned to your account
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
