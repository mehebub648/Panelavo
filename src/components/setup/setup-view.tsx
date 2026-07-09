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
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SystemStatus } from "@/server/network/system-status";

export function SetupView({
  status: initialStatus,
  isSuperAdmin,
}: {
  status: SystemStatus;
  isSuperAdmin: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<SystemStatus>(initialStatus);
  const [baseDomain, setBaseDomain] = useState(initialStatus.baseDomain);
  const [busy, setBusy] = useState<null | "save" | "register" | "recheck">(null);

  // Apply a fresh status; if the wildcard is now live, leave the setup screen.
  function apply(next: SystemStatus, becameReadyMessage?: string) {
    setStatus(next);
    setBaseDomain(next.baseDomain);
    if (next.ready) {
      if (becameReadyMessage) toast.success(becameReadyMessage);
      router.replace("/sites");
      router.refresh();
    }
  }

  async function call(
    kind: "save" | "register" | "recheck",
    run: () => Promise<Response>,
    onOk?: (data: { status: SystemStatus }) => void,
  ) {
    setBusy(kind);
    try {
      const response = await run();
      const result = await response.json();
      if (!result.success)
        throw new Error(result.error?.message || "Request failed.");
      onOk?.(result.data);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Request failed.");
    } finally {
      setBusy(null);
    }
  }

  const recheck = () =>
    call(
      "recheck",
      () => fetch("/api/setup", { headers: { "cache-control": "no-store" } }),
      (data) => {
        apply(data.status, "Wildcard is live");
        if (!data.status.ready) toast.info("Still not resolving here yet.");
      },
    );

  const saveBaseDomain = () =>
    call(
      "save",
      () =>
        fetch("/api/setup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "set-base-domain", baseDomain }),
        }),
      (data) => apply(data.status, "Base domain saved and wildcard is live"),
    );

  const register = () =>
    call(
      "register",
      () =>
        fetch("/api/setup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "register" }),
        }),
      (data) => {
        const withRegister = data as {
          status: SystemStatus;
          register?: { ok: boolean; error?: string };
        };
        if (withRegister.register && !withRegister.register.ok)
          toast.error(withRegister.register.error || "Registration failed.");
        apply(data.status, "Wildcard registered and live");
      },
    );

  const serverIp = status.serverIp || "this server";
  const shownWildcard =
    status.wildcardDomain ||
    `*.${status.serverIp || "<server-ip>"}.${baseDomain || "example.com"}`;

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <div className="flex items-center justify-between">
          <Brand />
          <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
            Setup required
          </span>
        </div>

        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
          <div className="flex items-center gap-3 border-b border-slate-100 bg-slate-50/60 px-6 py-5">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-panel-50 text-panel-600">
              <Globe2 className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-lg font-bold text-ink">Finish panel setup</h1>
              <p className="text-sm text-slate-500">
                Websites are served on{" "}
                <code className="text-slate-700">
                  site-&lt;id&gt;.{serverIp}.{baseDomain || "your-domain"}
                </code>
                , which needs one wildcard DNS record before the panel can be
                used.
              </p>
            </div>
          </div>

          <div className="space-y-5 p-6">
            <div
              className={`flex flex-wrap items-center gap-2 rounded-xl border px-4 py-3 text-sm ${
                status.pointed
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-amber-200 bg-amber-50 text-amber-700"
              }`}
            >
              {status.pointed ? (
                <>
                  <CheckCircle2 className="h-4 w-4" /> Wildcard resolves to this
                  server.
                </>
              ) : (
                <>
                  <TriangleAlert className="h-4 w-4" />
                  {status.reason || "The wildcard is not resolving here yet."}
                </>
              )}
            </div>

            {isSuperAdmin ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="baseDomain">Base domain</Label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      id="baseDomain"
                      value={baseDomain}
                      onChange={(event) =>
                        setBaseDomain(event.target.value.toLowerCase())
                      }
                      placeholder="mehebub.com"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy !== null || !baseDomain.trim()}
                      onClick={saveBaseDomain}
                    >
                      {busy === "save" ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <Save className="h-4 w-4" />
                      )}
                      Save
                    </Button>
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm">
                  <p className="font-semibold text-slate-800">
                    Required wildcard DNS record
                  </p>
                  <p className="mt-1 text-slate-600">
                    <code className="break-all">A {shownWildcard}</code> →{" "}
                    <b>{status.serverIp || "this server"}</b>
                  </p>
                  {status.canAutoRegister ? (
                    <div className="mt-3">
                      <Button
                        type="button"
                        disabled={busy !== null}
                        onClick={register}
                      >
                        {busy === "register" ? (
                          <LoaderCircle className="h-4 w-4 animate-spin" />
                        ) : (
                          <Zap className="h-4 w-4" />
                        )}
                        Auto-register wildcard
                      </Button>
                    </div>
                  ) : (
                    <div className="mt-4 space-y-3">
                      <p className="text-xs text-slate-500">
                        Create this A record in your DNS provider, then recheck.
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => {
                          setBaseDomain("mehebub.com");
                          call(
                            "save",
                            () =>
                              fetch("/api/setup", {
                                method: "POST",
                                headers: { "content-type": "application/json" },
                                body: JSON.stringify({ action: "set-base-domain", baseDomain: "mehebub.com" }),
                              }),
                            (data) => apply(data.status),
                          );
                        }}
                      >
                        Use default mehebub.com domain
                      </Button>
                    </div>
                  )}
                </div>

                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={recheck}
                  >
                    {busy === "recheck" ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4" />
                    )}
                    Recheck DNS
                  </Button>
                </div>
              </>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-slate-600">
                  This panel is still being set up. A super administrator needs
                  to configure the base domain and DNS before it can be used.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={recheck}
                >
                  {busy === "recheck" ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Recheck
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
