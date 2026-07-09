"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowRightCircle,
  Ban,
  CheckCircle2,
  Globe2,
  LoaderCircle,
  Lock,
  Plus,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

type Meta = {
  id: number;
  category: string;
  aliases: string[];
  block: "none" | "error" | "redirect";
  redirectTo?: string;
};
type DnsEntry = { name: string; ip: string | null; pointed: boolean };
type Data = { meta: Meta | null; serverIp: string; dns: DnsEntry[]; warnings?: string[] };

export function DomainsManager({
  domain,
  canWrite,
}: {
  domain: string;
  canWrite: boolean;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>("");
  const [aliasDraft, setAliasDraft] = useState("");
  const [sslSelection, setSslSelection] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);

  const base = `/api/sites/${encodeURIComponent(domain)}/domains`;

  const refresh = useCallback(async () => {
    try {
      const result = await fetch(base, { cache: "no-store" }).then((r) => r.json());
      if (result.success) setData(result.data);
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(body: Record<string, unknown>, key: string, success: string) {
    setBusy(key);
    try {
      const response = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!result.success)
        throw new Error(result.error?.message || "The change could not be applied.");
      setData(result.data);
      for (const warning of (result.data.warnings as string[] | undefined) ?? [])
        toast.warning(warning, { duration: 12000 });
      toast.success(success);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The change could not be applied.");
    } finally {
      setBusy("");
    }
  }

  if (loading)
    return <div className="h-72 animate-pulse rounded-2xl border border-slate-200 bg-white" />;

  const meta = data?.meta ?? null;
  const dnsFor = (name: string) => data?.dns.find((entry) => entry.name === name);

  if (!meta)
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
        <p className="flex items-center gap-2 font-semibold">
          <TriangleAlert className="h-5 w-5" /> No domain metadata
        </p>
        <p className="mt-2">
          This website was created outside the panel&apos;s id scheme, so alias and
          system-domain management is not available for it.
        </p>
      </div>
    );

  const systemDns = dnsFor(domain);
  const allNames = [domain, ...meta.aliases];

  return (
    <div className="w-full space-y-5">
      {/* System domain */}
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
        <div className="flex items-center gap-3 border-b border-slate-100 bg-slate-50/60 px-5 py-4 sm:px-6">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-panel-50 text-panel-600">
            <Globe2 className="h-5 w-5" />
          </span>
          <div>
            <h3 className="font-bold">System domain</h3>
            <p className="text-sm text-slate-500">
              Site id {meta.id} · category {meta.category} · port {meta.id}
            </p>
          </div>
        </div>
        <div className="space-y-4 p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 px-4 py-3 text-sm">
            <b className="break-all">{domain}</b>
            {systemDns?.pointed ? (
              <span className="flex items-center gap-1.5 font-medium text-emerald-600">
                <CheckCircle2 className="h-4 w-4" /> Points here
              </span>
            ) : (
              <span className="flex items-center gap-1.5 font-medium text-amber-600">
                <TriangleAlert className="h-4 w-4" />
                {systemDns?.ip ? `Points to ${systemDns.ip}` : "No DNS record"}
                {canWrite && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== ""}
                    onClick={() =>
                      void act({ action: "point-dns", domain }, "dns-system", "DNS record updated")
                    }
                  >
                    {busy === "dns-system" ? (
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ArrowRightCircle className="h-3.5 w-3.5" />
                    )}
                    Point here
                  </Button>
                )}
              </span>
            )}
          </div>
          <div>
            <Label htmlFor="blockMode">When someone opens the system domain</Label>
            <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
              <Select
                id="blockMode"
                value={meta.block}
                disabled={!canWrite || busy !== ""}
                onChange={(event) => {
                  const block = event.target.value as Meta["block"];
                  void act(
                    { action: "set-block", block, redirectTo: meta.redirectTo },
                    "block",
                    "System domain behavior saved",
                  );
                }}
                className="sm:max-w-xs"
              >
                <option value="none">Serve the website normally</option>
                <option value="error" disabled={!meta.aliases.length}>
                  Block with an error (403)
                </option>
                <option value="redirect" disabled={!meta.aliases.length}>
                  Redirect to one of your domains
                </option>
              </Select>
              {meta.block === "redirect" && (
                <Select
                  aria-label="Redirect target"
                  value={meta.redirectTo ?? meta.aliases[0] ?? ""}
                  disabled={!canWrite || busy !== ""}
                  onChange={(event) =>
                    void act(
                      { action: "set-block", block: "redirect", redirectTo: event.target.value },
                      "block",
                      "Redirect target saved",
                    )
                  }
                  className="sm:max-w-xs"
                >
                  {meta.aliases.map((alias) => (
                    <option key={alias} value={alias}>
                      {alias}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            <p className="mt-1.5 text-xs text-slate-400">
              {meta.aliases.length
                ? "Blocking only affects the system domain — your own domains keep working."
                : "Add one of your own domains below to enable blocking or redirecting."}
            </p>
          </div>
        </div>
      </section>

      {/* Alias domains */}
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
        <div className="flex items-center gap-3 border-b border-slate-100 bg-slate-50/60 px-5 py-4 sm:px-6">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-50 text-emerald-600">
            <Plus className="h-5 w-5" />
          </span>
          <div>
            <h3 className="font-bold">Your domains</h3>
            <p className="text-sm text-slate-500">
              Customer-facing domains served by this website as aliases.
            </p>
          </div>
        </div>
        <div className="space-y-4 p-5 sm:p-6">
          {canWrite && (
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const alias = aliasDraft.trim().toLowerCase();
                if (!alias) return;
                setAliasDraft("");
                void act({ action: "add-alias", domain: alias }, "add", `${alias} added`);
              }}
            >
              <Input
                value={aliasDraft}
                onChange={(event) => setAliasDraft(event.target.value)}
                placeholder="example.com"
                autoComplete="off"
              />
              <Button type="submit" disabled={busy !== "" || !aliasDraft.trim()}>
                {busy === "add" ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                Add domain
              </Button>
            </form>
          )}
          {meta.aliases.length === 0 ? (
            <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
              No domains added yet — the website is reachable on its system domain.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-xl border border-slate-100">
              {meta.aliases.map((alias) => {
                const dns = dnsFor(alias);
                return (
                  <li
                    key={alias}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
                  >
                    <span className="break-all font-medium text-slate-800">{alias}</span>
                    <span className="flex items-center gap-2">
                      {dns?.pointed ? (
                        <span className="flex items-center gap-1.5 text-emerald-600">
                          <CheckCircle2 className="h-4 w-4" /> Points here
                        </span>
                      ) : (
                        <>
                          <span className="flex items-center gap-1.5 text-amber-600">
                            <TriangleAlert className="h-4 w-4" />
                            {dns?.ip ? `Points to ${dns.ip}` : "No DNS record"}
                          </span>
                          {canWrite && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy !== ""}
                              onClick={() =>
                                void act(
                                  { action: "point-dns", domain: alias },
                                  `dns-${alias}`,
                                  "DNS record updated",
                                )
                              }
                            >
                              {busy === `dns-${alias}` ? (
                                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <ArrowRightCircle className="h-3.5 w-3.5" />
                              )}
                              Point here
                            </Button>
                          )}
                        </>
                      )}
                      {canWrite && (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Remove ${alias}`}
                          disabled={busy !== ""}
                          onClick={() =>
                            setConfirm({
                              title: "Remove domain",
                              message: `Stop serving ${alias} from this website? Its panel-managed DNS record is removed as well.`,
                              onConfirm: () => {
                                setConfirm(null);
                                void act(
                                  { action: "remove-alias", domain: alias },
                                  `remove-${alias}`,
                                  `${alias} removed`,
                                );
                              },
                            })
                          }
                        >
                          {busy === `remove-${alias}` ? (
                            <LoaderCircle className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4 text-red-500" />
                          )}
                        </Button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* SSL */}
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
        <div className="flex items-center gap-3 border-b border-slate-100 bg-slate-50/60 px-5 py-4 sm:px-6">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-violet-50 text-violet-600">
            <Lock className="h-5 w-5" />
          </span>
          <div>
            <h3 className="font-bold">SSL certificate</h3>
            <p className="text-sm text-slate-500">
              Issue one Let&apos;s Encrypt certificate covering the selected domains.
              Every selected domain must already point to this server.
            </p>
          </div>
        </div>
        <div className="space-y-4 p-5 sm:p-6">
          <div className="flex flex-wrap gap-2">
            {allNames.map((name) => {
              const selected = sslSelection.includes(name);
              const pointed = dnsFor(name)?.pointed;
              return (
                <button
                  key={name}
                  type="button"
                  disabled={!canWrite}
                  onClick={() =>
                    setSslSelection((current) =>
                      selected
                        ? current.filter((item) => item !== name)
                        : [...current, name],
                    )
                  }
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
                    selected
                      ? "border-panel-400 bg-panel-50 text-panel-700"
                      : "border-slate-200 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {selected ? <CheckCircle2 className="h-4 w-4" /> : <Ban className="h-4 w-4 opacity-30" />}
                  <span className="break-all">{name}</span>
                  {!pointed && <TriangleAlert className="h-3.5 w-3.5 text-amber-500" />}
                </button>
              );
            })}
          </div>
          {canWrite && (
            <Button
              disabled={busy !== "" || !sslSelection.length}
              onClick={() =>
                void act(
                  { action: "issue-ssl", domains: sslSelection },
                  "ssl",
                  "Certificate issued",
                )
              }
            >
              {busy === "ssl" ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              Issue certificate
            </Button>
          )}
          <p className="text-xs text-slate-400">
            Installed certificates are shown below on this page. Issuing can take up
            to a minute.
          </p>
        </div>
      </section>

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
