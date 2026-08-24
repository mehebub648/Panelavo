"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ExternalLink,
  LoaderCircle,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ProjectPort = { port: number; address: string; process?: string };
type ProjectEndpoint = {
  domain: string;
  serviceName: string;
  aliases: string[];
  targetPort?: number;
  reverseProxyUrl?: string;
  status: "active" | "pending" | "unhealthy";
  accessible: boolean;
};

const statusStyle = {
  active: "bg-emerald-50 text-emerald-700",
  pending: "bg-amber-50 text-amber-700",
  unhealthy: "bg-red-50 text-red-700",
};

export function LinkedServices({
  parentDomain,
  canWrite,
}: {
  parentDomain: string;
  canWrite: boolean;
}) {
  const [services, setServices] = useState<ProjectEndpoint[] | null>(null);
  const [ports, setPorts] = useState<ProjectPort[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<ProjectEndpoint | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectEndpoint | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/sites/${encodeURIComponent(parentDomain)}/services`,
        { cache: "no-store" },
      );
      const result = await response.json();
      if (result.success) {
        setServices(result.data.services);
        setPorts(result.data.ports ?? []);
      } else setServices([]);
    } catch {
      setServices([]);
    }
  }, [parentDomain]);

  useEffect(() => {
    void load();
  }, [load]);

  function endpointUrl(domain: string) {
    return `/api/sites/${encodeURIComponent(parentDomain)}/services/${encodeURIComponent(domain)}`;
  }

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("create");
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
            allowPending: true,
          }),
        },
      );
      const result = await response.json();
      if (!result.success)
        throw new Error(
          result.error?.message || "The endpoint could not be created.",
        );
      toast.success(
        result.data.endpoint.status === "pending"
          ? "Endpoint reserved as pending"
          : "Project endpoint activated",
      );
      for (const warning of result.data.warnings ?? []) toast.warning(warning);
      setShowForm(false);
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The endpoint could not be created.",
      );
    } finally {
      setBusy("");
    }
  }

  async function verify(endpoint: ProjectEndpoint) {
    setBusy(`verify:${endpoint.domain}`);
    try {
      const response = await fetch(endpointUrl(endpoint.domain), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const result = await response.json();
      if (!result.success)
        throw new Error(result.error?.message || "Verification failed.");
      if (!result.data.verified)
        throw new Error(
          result.data.verification?.detail || "The endpoint is not healthy.",
        );
      toast.success(
        result.data.activated
          ? "Endpoint verified and activated"
          : "Endpoint is healthy",
      );
      for (const warning of result.data.warnings ?? []) toast.warning(warning);
      await load();
    } catch (reason) {
      toast.error(
        reason instanceof Error ? reason.message : "Verification failed.",
      );
    } finally {
      setBusy("");
    }
  }

  async function savePort(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const data = new FormData(event.currentTarget);
    setBusy(`edit:${editing.domain}`);
    try {
      const response = await fetch(endpointUrl(editing.domain), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetPort: Number(data.get("targetPort")) }),
      });
      const result = await response.json();
      if (!result.success)
        throw new Error(
          result.error?.message || "The port could not be changed.",
        );
      toast.success(
        result.data.pending
          ? "Pending endpoint reservation updated"
          : "Endpoint changed and health-checked",
      );
      setEditing(null);
      await load();
    } catch (reason) {
      toast.error(
        reason instanceof Error
          ? reason.message
          : "The port could not be changed.",
      );
    } finally {
      setBusy("");
    }
  }

  async function remove(endpoint: ProjectEndpoint) {
    setDeleteTarget(null);
    setBusy(`delete:${endpoint.domain}`);
    try {
      const response = await fetch(endpointUrl(endpoint.domain), {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const result = await response.json();
      if (!result.success)
        throw new Error(
          result.error?.message || "The endpoint could not be deleted.",
        );
      toast.success("Project endpoint deleted");
      await load();
    } catch (reason) {
      toast.error(
        reason instanceof Error
          ? reason.message
          : "The endpoint could not be deleted.",
      );
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-white/40 bg-white/60 shadow-card backdrop-blur-md">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200/50 bg-slate-50/40 px-5 py-4 sm:px-6">
        <div>
          <h3 className="font-bold">Project endpoints</h3>
          <p className="mt-1 text-sm text-slate-500">
            Give a project-owned loopback port its own HTTPS domain. Panelavo
            verifies ownership and HTTP health before making it public.
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
            <Plus className="h-4 w-4" /> Add endpoint
          </Button>
        )}
      </div>

      {showForm && canWrite && (
        <form
          onSubmit={create}
          className="grid gap-4 border-b border-slate-100 bg-panel-50/30 p-5 sm:grid-cols-3 sm:p-6"
        >
          <div>
            <Label htmlFor="serviceName">Endpoint name</Label>
            <Input
              id="serviceName"
              name="serviceName"
              required
              maxLength={32}
              pattern={"[a-zA-Z][a-zA-Z0-9\\-]*"}
              placeholder="api"
              className="mt-1.5 bg-white/70"
            />
          </div>
          <div>
            <Label htmlFor="targetPort">Project port</Label>
            <Input
              id="targetPort"
              name="targetPort"
              type="number"
              list="project-endpoint-ports"
              required
              min={1024}
              max={65535}
              placeholder={ports[0] ? String(ports[0].port) : "22001"}
              className="mt-1.5 bg-white/70"
            />
            <datalist id="project-endpoint-ports">
              {ports.map((port) => (
                <option key={`${port.address}:${port.port}`} value={port.port}>
                  {port.process || "Project process"}
                </option>
              ))}
            </datalist>
            <p className="mt-1.5 text-xs text-slate-400">
              {ports.length
                ? `${ports.length} verified loopback port${ports.length === 1 ? "" : "s"} detected.`
                : "A stopped service can be reserved as pending; it will not be public until verified."}
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
          </div>
          {error && (
            <p className="text-sm text-red-600 sm:col-span-3">{error}</p>
          )}
          <div className="flex justify-end gap-2 sm:col-span-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setShowForm(false)}
              disabled={busy === "create"}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy === "create"}>
              {busy === "create" ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}{" "}
              Add endpoint
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
          No project endpoints yet.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {services.map((service) => (
            <li key={service.domain} className="px-5 py-4 sm:px-6">
              <div className="flex flex-wrap items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-rose-50 text-rose-600">
                  <Network className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-slate-800">
                      {service.serviceName}
                    </p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusStyle[service.status]}`}
                    >
                      {service.status}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-slate-400">
                    {service.aliases[0] || service.domain}
                    {service.targetPort && (
                      <>
                        <span className="mx-1.5 opacity-50">•</span>127.0.0.1:
                        {service.targetPort}
                      </>
                    )}
                  </p>
                </div>
                {canWrite && (
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => void verify(service)}
                      disabled={Boolean(busy)}
                      aria-label={`Verify ${service.serviceName}`}
                    >
                      {busy === `verify:${service.domain}` ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setEditing(service)}
                      disabled={Boolean(busy)}
                      aria-label={`Change port for ${service.serviceName}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleteTarget(service)}
                      disabled={Boolean(busy)}
                      aria-label={`Delete ${service.serviceName}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
                {service.accessible && (
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
                )}
              </div>
              {editing?.domain === service.domain && (
                <form
                  onSubmit={savePort}
                  className="mt-3 flex flex-wrap items-end gap-2 rounded-xl bg-slate-50 p-3"
                >
                  <div>
                    <Label htmlFor={`port-${service.domain}`}>
                      New project port
                    </Label>
                    <Input
                      id={`port-${service.domain}`}
                      name="targetPort"
                      type="number"
                      min={1024}
                      max={65535}
                      defaultValue={service.targetPort}
                      required
                      className="mt-1 w-40 bg-white"
                    />
                  </div>
                  <Button type="submit" size="sm" disabled={Boolean(busy)}>
                    Save and verify
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditing(null)}
                    disabled={Boolean(busy)}
                  >
                    Cancel
                  </Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete project endpoint"
          message={`Delete ${deleteTarget.serviceName} and its reverse-proxy website? The parent project and its application data will not be changed.`}
          onConfirm={() => void remove(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </section>
  );
}
