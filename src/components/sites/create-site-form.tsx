"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Braces,
  Cloud,
  AlertTriangle,
  Check,
  Clipboard,
  Code2,
  Container,
  Eye,
  EyeOff,
  FileCode2,
  LoaderCircle,
  Network,
  RotateCcw,
  Server,
} from "lucide-react";
import { toast } from "sonner";
import type { SiteCreationOptions, SiteType } from "@/types/cloudpanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { normalizeDomain } from "@/schemas/sites";
import { cn } from "@/lib/utils";

const types = [
  {
    id: "php" as const,
    name: "PHP site",
    description: "PHP applications and frameworks",
    icon: Code2,
    color: "text-violet-600 bg-violet-50",
  },
  {
    id: "nodejs" as const,
    name: "Node.js site",
    description: "Server-side JavaScript apps",
    icon: Braces,
    color: "text-emerald-600 bg-emerald-50",
  },
  {
    id: "static" as const,
    name: "Static HTML",
    description: "HTML, CSS, and JavaScript",
    icon: FileCode2,
    color: "text-amber-600 bg-amber-50",
  },
  {
    id: "python" as const,
    name: "Python site",
    description: "Python web applications",
    icon: Server,
    color: "text-blue-600 bg-blue-50",
  },
  {
    id: "reverse-proxy" as const,
    name: "Reverse proxy",
    description: "Forward traffic to another service",
    icon: Network,
    color: "text-rose-600 bg-rose-50",
  },
  {
    id: "docker" as const,
    name: "Docker app",
    description: "Serve a containerized application",
    icon: Container,
    color: "text-sky-600 bg-sky-50",
  },
];

function makePassword() {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%+=_-";
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (byte) => chars[byte % chars.length]).join("");
}

type Values = {
  domain: string;
  siteUser: string;
  siteUserPassword: string;
  phpVersion: string;
  vhostTemplate: string;
  nodeVersion: string;
  pythonVersion: string;
  appPort: string;
  reverseProxyUrl: string;
};
type CloudflareZone = { id: string; name: string; credentialId: string; credentialLabel: string };
const initial: Values = {
  domain: "",
  siteUser: "",
  siteUserPassword: "",
  phpVersion: "",
  vhostTemplate: "",
  nodeVersion: "",
  pythonVersion: "",
  appPort: "3000",
  reverseProxyUrl: "http://127.0.0.1:8000",
};

export function CreateSiteForm() {
  const router = useRouter();
  const [options, setOptions] = useState<SiteCreationOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [type, setType] = useState<SiteType | null>(null);
  const [values, setValues] = useState(initial);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [zones, setZones] = useState<CloudflareZone[]>([]);
  const [domainMode, setDomainMode] = useState<"cloudflare" | "custom">("cloudflare");
  const [selectedZone, setSelectedZone] = useState<CloudflareZone | null>(null);
  const [subdomain, setSubdomain] = useState("");
  const [existingRecord, setExistingRecord] = useState<{ content: string } | null>(null);
  const [replaceRecord, setReplaceRecord] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const [result, zoneResult] = await Promise.all([fetch("/api/sites/options", { cache: "no-store" }).then((r) => r.json()), fetch("/api/cloudflare/zones", { cache: "no-store" }).then((r) => r.json())]);
        if (!result.success)
          throw new Error(
            result.error?.message || "Options could not be loaded.",
          );
        const next = result.data.options as SiteCreationOptions;
        if (zoneResult.success) { setZones(zoneResult.data.zones); if (!zoneResult.data.zones.length) setDomainMode("custom"); }
        setOptions(next);
        setValues((current) => ({
          ...current,
          phpVersion: next.phpVersions[0] || "",
          nodeVersion: next.nodeVersions[0] || "",
          pythonVersion: next.pythonVersions[0] || "",
          vhostTemplate: next.vhostTemplates[0] || "",
        }));
      } catch (reason) {
        setLoadError(
          reason instanceof Error
            ? reason.message
            : "Options could not be loaded.",
        );
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  const selected = useMemo(
    () => types.find((item) => item.id === type),
    [type],
  );
  const SelectedIcon = selected?.icon;
  function change(key: keyof Values, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }
  function generate() {
    const password = makePassword();
    change("siteUserPassword", password);
    setShowPassword(true);
  }
  async function copyPassword() {
    await navigator.clipboard.writeText(values.siteUserPassword);
    setCopied(true);
    toast.success("Password copied");
    setTimeout(() => setCopied(false), 1400);
  }
  function domainBlur() {
    const domain = normalizeDomain(values.domain);
    setValues((current) => ({
      ...current,
      domain,
      siteUser:
        current.siteUser ||
        domain
          .split(".")[0]
          .replace(/[^a-z0-9-]/g, "")
          .slice(0, 28),
    }));
  }
  async function checkRecord(domain: string, zone = selectedZone) {
    if (!zone || !domain) { setExistingRecord(null); return; }
    const result = await fetch(`/api/cloudflare/check?credentialId=${encodeURIComponent(zone.credentialId)}&zoneId=${encodeURIComponent(zone.id)}&name=${encodeURIComponent(domain)}`).then((r) => r.json());
    if (result.success) setExistingRecord(result.data.record);
  }
  function chooseZone(value: string) {
    const zone = zones.find((item) => `${item.credentialId}:${item.id}` === value) ?? null; setSelectedZone(zone); setSubdomain(""); setExistingRecord(null);
    if (zone) { change("domain", zone.name); void checkRecord(zone.name, zone); }
  }
  function changeSubdomain(value: string) { const clean = value.toLowerCase().replace(/[^a-z0-9-]/g, ""); setSubdomain(clean); if (selectedZone) { const domain = clean ? `${clean}.${selectedZone.name}` : selectedZone.name; change("domain", domain); } }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!type) return;
    setBusy(true);
    setError("");
    const shared = {
      type,
      domain: values.domain,
      siteUser: values.siteUser,
      siteUserPassword: values.siteUserPassword,
    };
    const body =
      type === "php"
        ? {
            ...shared,
            phpVersion: values.phpVersion,
            vhostTemplate: values.vhostTemplate,
          }
        : type === "nodejs"
          ? {
              ...shared,
              nodeVersion: values.nodeVersion,
              appPort: Number(values.appPort),
            }
          : type === "python"
            ? {
                ...shared,
                pythonVersion: values.pythonVersion,
                appPort: Number(values.appPort),
              }
            : type === "reverse-proxy"
              ? { ...shared, reverseProxyUrl: values.reverseProxyUrl }
              : type === "docker"
                ? { ...shared, appPort: Number(values.appPort) }
                : shared;
    const requestBody = domainMode === "cloudflare" && selectedZone ? { ...body, dns: { credentialId: selectedZone.credentialId, zoneId: selectedZone.id, replace: replaceRecord, proxied: false } } : body;
    try {
      const response = await fetch("/api/sites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const result = await response.json();
      if (!result.success)
        throw new Error(
          result.error?.message || "The website could not be created.",
        );
      setValues(initial);
      router.push(
        `/sites?created=${encodeURIComponent(result.data.site.domain)}`,
      );
      router.refresh();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The website could not be created.",
      );
      setValues((current) => ({ ...current, siteUserPassword: "" }));
    } finally {
      setBusy(false);
    }
  }

  if (loading)
    return (
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="h-28 animate-pulse rounded-2xl border border-slate-200 bg-white" />
        <div className="h-96 animate-pulse rounded-2xl border border-slate-200 bg-white" />
      </div>
    );
  if (loadError)
    return (
      <div className="mx-auto max-w-3xl rounded-2xl border border-red-200 bg-white p-10 text-center shadow-card">
        <h2 className="text-xl font-bold">Site options unavailable</h2>
        <p className="mt-2 text-sm text-slate-500">{loadError}</p>
        <Button asChild variant="outline" className="mt-6">
          <Link href="/sites">Back to websites</Link>
        </Button>
      </div>
    );

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        href="/sites"
        className="mb-5 inline-flex items-center gap-2 text-sm font-semibold text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to websites
      </Link>
      <div className="mb-7 flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">
            Create a website
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Choose a site type, then add its CloudPanel configuration.
          </p>
        </div>
        <div className="hidden items-center gap-3 text-xs font-semibold sm:flex">
          <span
            className={cn(
              "grid h-7 w-7 place-items-center rounded-full",
              type ? "bg-emerald-500 text-white" : "bg-panel-600 text-white",
            )}
          >
            {type ? <Check className="h-4 w-4" /> : "1"}
          </span>
          <span className="text-slate-500">Site type</span>
          <span className="h-px w-10 bg-slate-200" />
          <span
            className={cn(
              "grid h-7 w-7 place-items-center rounded-full",
              type ? "bg-panel-600 text-white" : "bg-slate-100 text-slate-400",
            )}
          >
            2
          </span>
          <span className={type ? "text-slate-700" : "text-slate-400"}>
            Configuration
          </span>
        </div>
      </div>
      {!type ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card sm:p-7">
          <div className="mb-5">
            <h3 className="font-bold">What would you like to host?</h3>
            <p className="mt-1 text-sm text-slate-500">
              Only types supported by this CloudPanel installation are shown.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {types
              .filter((item) => options?.allowedTypes.includes(item.id))
              .map(({ id, name, description, icon: Icon, color }) => (
                <button
                  key={id}
                  onClick={() => setType(id)}
                  className="hover:border-panel-300 group relative rounded-xl border border-slate-200 p-5 text-left outline-none transition hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-2 focus-visible:ring-panel-500"
                >
                  <span
                    className={cn(
                      "grid h-11 w-11 place-items-center rounded-xl",
                      color,
                    )}
                  >
                    <Icon className="h-5 w-5" />
                  </span>
                  <h4 className="mt-4 font-bold text-slate-800">{name}</h4>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    {description}
                  </p>
                  <ArrowRight className="absolute right-4 top-4 h-4 w-4 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-panel-600" />
                </button>
              ))}
          </div>
        </section>
      ) : (
        <form
          onSubmit={submit}
          className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card"
        >
          <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/60 px-5 py-4 sm:px-7">
            <div className="flex items-center gap-3">
              <span
                className={cn(
                  "grid h-10 w-10 place-items-center rounded-xl",
                  selected?.color,
                )}
              >
                {SelectedIcon && <SelectedIcon className="h-5 w-5" />}
              </span>
              <div>
                <h3 className="font-bold">{selected?.name}</h3>
                <p className="text-xs text-slate-400">Website configuration</p>
              </div>
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setType(null);
                setError("");
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Change type
            </Button>
          </div>
          <div className="grid gap-x-6 gap-y-5 p-5 sm:grid-cols-2 sm:p-7">
            <div className="sm:col-span-2">
              <div className="mb-3 flex gap-2"><button type="button" onClick={() => setDomainMode("cloudflare")} disabled={!zones.length} className={`rounded-lg border px-3 py-2 text-sm font-medium ${domainMode === "cloudflare" ? "border-panel-400 bg-panel-50 text-panel-700" : "border-slate-200"}`}><Cloud className="mr-2 inline h-4 w-4" />Cloudflare domain</button><button type="button" onClick={() => { setDomainMode("custom"); setSelectedZone(null); setExistingRecord(null); }} className={`rounded-lg border px-3 py-2 text-sm font-medium ${domainMode === "custom" ? "border-panel-400 bg-panel-50 text-panel-700" : "border-slate-200"}`}>Custom domain</button></div>
              {domainMode === "cloudflare" ? <div className="grid gap-3 sm:grid-cols-2"><div><Label>Cloudflare zone</Label><Select value={selectedZone ? `${selectedZone.credentialId}:${selectedZone.id}` : ""} onChange={(e) => chooseZone(e.target.value)} required><option value="">Select a zone…</option>{zones.map((zone) => <option key={`${zone.credentialId}:${zone.id}`} value={`${zone.credentialId}:${zone.id}`}>{zone.name} · {zone.credentialLabel}</option>)}</Select></div><div><Label htmlFor="subdomain">Subdomain (optional)</Label><Input id="subdomain" value={subdomain} onChange={(e) => changeSubdomain(e.target.value)} onBlur={() => void checkRecord(values.domain)} placeholder="www, app, api…" disabled={!selectedZone} /></div><div className="sm:col-span-2 rounded-xl bg-slate-50 px-4 py-3 text-sm"><span className="text-slate-500">Website domain:</span> <b>{values.domain || "Select a zone"}</b><p className="mt-1 text-xs text-slate-500">An A record will be created automatically for this server.</p></div></div> : <><Label htmlFor="domain">Domain name</Label><Input id="domain" value={values.domain} onChange={(e) => change("domain", e.target.value)} onBlur={domainBlur} placeholder="example.com" autoComplete="off" required /><p className="mt-1.5 text-xs text-slate-400">Any domain is allowed; Cloudflare is not required.</p></>}
              {existingRecord && <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"><div className="flex gap-2"><AlertTriangle className="h-5 w-5 shrink-0" /><div><b>An A record already exists</b><p className="mt-1">{values.domain} currently points to {existingRecord.content}.</p><label className="mt-3 flex items-center gap-2 font-medium"><input type="checkbox" checked={replaceRecord} onChange={(e) => setReplaceRecord(e.target.checked)} />Replace it with this server&apos;s IP</label></div></div></div>}
            </div>
            {type === "php" && (
              <>
                <div>
                  <Label htmlFor="phpVersion">PHP version</Label>
                  <Select
                    id="phpVersion"
                    value={values.phpVersion}
                    onChange={(e) => change("phpVersion", e.target.value)}
                    required
                  >
                    {options?.phpVersions.map((version) => (
                      <option key={version} value={version}>
                        PHP {version}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="vhostTemplate">Application template</Label>
                  <Select
                    id="vhostTemplate"
                    value={values.vhostTemplate}
                    onChange={(e) => change("vhostTemplate", e.target.value)}
                    required
                  >
                    {options?.vhostTemplates.map((template) => (
                      <option key={template} value={template}>
                        {template}
                      </option>
                    ))}
                  </Select>
                </div>
              </>
            )}
            {type === "nodejs" && (
              <>
                <div>
                  <Label htmlFor="nodeVersion">Node.js version</Label>
                  <Select
                    id="nodeVersion"
                    value={values.nodeVersion}
                    onChange={(e) => change("nodeVersion", e.target.value)}
                    required
                  >
                    {options?.nodeVersions.map((version) => (
                      <option key={version} value={version}>
                        Node.js {version}
                      </option>
                    ))}
                  </Select>
                </div>
                <PortField
                  value={values.appPort}
                  onChange={(value) => change("appPort", value)}
                />
              </>
            )}
            {type === "python" && (
              <>
                <div>
                  <Label htmlFor="pythonVersion">Python version</Label>
                  <Select
                    id="pythonVersion"
                    value={values.pythonVersion}
                    onChange={(e) => change("pythonVersion", e.target.value)}
                    required
                  >
                    {options?.pythonVersions.map((version) => (
                      <option key={version} value={version}>
                        Python {version}
                      </option>
                    ))}
                  </Select>
                </div>
                <PortField
                  value={values.appPort}
                  onChange={(value) => change("appPort", value)}
                />
              </>
            )}
            {type === "docker" && (
              <div className="sm:col-span-2">
                <PortField
                  value={values.appPort}
                  onChange={(value) => change("appPort", value)}
                />
                <p className="mt-2 rounded-xl bg-sky-50 px-4 py-3 text-xs leading-5 text-sky-800">
                  NGINX will proxy this domain to <b>http://127.0.0.1:{values.appPort || "…"}</b>.
                  Publish your container on that port (for example{" "}
                  <code className="rounded bg-white/70 px-1 py-0.5">docker run -p {values.appPort || "3000"}:80 …</code>{" "}
                  or a compose file), then use the site&apos;s Actions tab to manage it.
                </p>
              </div>
            )}
            {type === "reverse-proxy" && (
              <div className="sm:col-span-2">
                <Label htmlFor="reverseProxyUrl">Reverse proxy URL</Label>
                <Input
                  id="reverseProxyUrl"
                  type="url"
                  value={values.reverseProxyUrl}
                  onChange={(e) => change("reverseProxyUrl", e.target.value)}
                  placeholder="http://127.0.0.1:8000"
                  required
                />
                <p className="mt-1.5 text-xs text-slate-400">
                  HTTP and HTTPS targets are supported.
                </p>
              </div>
            )}
            <div>
              <Label htmlFor="siteUser">Site user</Label>
              <Input
                id="siteUser"
                value={values.siteUser}
                onChange={(e) =>
                  change("siteUser", e.target.value.toLowerCase())
                }
                placeholder="example"
                autoComplete="off"
                required
              />
            </div>
            <div>
              <Label htmlFor="sitePassword">Site user password</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="sitePassword"
                    type={showPassword ? "text" : "password"}
                    value={values.siteUserPassword}
                    onChange={(e) => change("siteUserPassword", e.target.value)}
                    placeholder="Generate a secure password"
                    autoComplete="new-password"
                    className="pr-10"
                    minLength={12}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    className="absolute right-0 top-0 grid h-11 w-10 place-items-center text-slate-400"
                    aria-label={
                      showPassword ? "Hide password" : "Show password"
                    }
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={generate}
                  aria-label="Generate password"
                >
                  <RotateCcw className="h-4 w-4" />
                </Button>
                {values.siteUserPassword && (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={copyPassword}
                    aria-label="Copy password"
                  >
                    {copied ? (
                      <Check className="h-4 w-4 text-emerald-600" />
                    ) : (
                      <Clipboard className="h-4 w-4" />
                    )}
                  </Button>
                )}
              </div>
            </div>
            {error && (
              <div
                role="alert"
                className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 sm:col-span-2"
              >
                {error}
                {!values.siteUserPassword && (
                  <span className="block pt-1 text-xs">
                    For safety, the site password was cleared. Generate or enter
                    it again.
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center justify-end gap-3 border-t border-slate-100 bg-slate-50/60 px-5 py-4 sm:px-7">
            <Button type="button" variant="ghost" asChild>
              <Link href="/sites">Cancel</Link>
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? (
                <>
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  Creating website…
                </>
              ) : (
                <>
                  Create website
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function PortField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <Label htmlFor="appPort">Application port</Label>
      <Input
        id="appPort"
        type="number"
        min={1024}
        max={65535}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
      />
      <p className="mt-1.5 text-xs text-slate-400">
        Use a port from 1024 to 65535.
      </p>
    </div>
  );
}
