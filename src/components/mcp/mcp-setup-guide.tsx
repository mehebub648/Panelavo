"use client";

import React, { useState } from "react";
import {
  Bot,
  CheckCircle2,
  Download,
  KeyRound,
  LoaderCircle,
  Plug,
  Server,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { CloudPanelUser, PanelRole } from "@/types/cloudpanel";
import type { PublicMcpConnection } from "@/server/mcp/oauth";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyValue } from "@/components/ui/copy-value";

export function mcpAccessSummary(role: PanelRole | undefined) {
  if (role === "super-admin")
    return {
      title: "All websites and repairs",
      detail: "All websites, including host-level website repairs.",
    };
  if (role === "manager")
    return {
      title: "All websites",
      detail: "All websites, without user management or panel settings.",
    };
  if (role === "admin")
    return {
      title: "Your websites",
      detail: "Websites assigned to you and websites you create.",
    };
  return {
    title: "Assigned websites",
    detail: "The websites assigned to you, with view-only access.",
  };
}

function formatDate(value: string | number | undefined) {
  if (!value) return "Not used yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function NumberedStep({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-panel-100 text-xs font-bold text-panel-700">
        {number}
      </span>
      <div className="min-w-0 pt-0.5">
        <p className="text-sm font-semibold text-slate-800">{title}</p>
        <div className="mt-1 text-sm leading-6 text-slate-500">{children}</div>
      </div>
    </li>
  );
}

export function McpSetupGuide({
  user,
  initialConnections,
  apiBase = "/api/profile/mcp-connections",
  pluginDownloadUrl = "/api/profile/panelavo-plugin",
}: {
  user: CloudPanelUser;
  initialConnections: PublicMcpConnection[];
  apiBase?: string;
  pluginDownloadUrl?: string;
}) {
  const [connections, setConnections] = useState(initialConnections);
  const [disconnecting, setDisconnecting] =
    useState<PublicMcpConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const access = mcpAccessSummary(user.panelRole);
  const prompts = [
    "Show my connected Panelavo servers and the websites on each one.",
    "Check example.com and explain any deployment blockers. Do not change anything yet.",
    "Create an on-server backup of example.com, then deploy its recommended plan.",
    "Verify the app, configured port, proxy, and public website for example.com.",
  ];

  async function downloadPlugin() {
    setDownloading(true);
    try {
      const response = await fetch(pluginDownloadUrl, { cache: "no-store" });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        throw new Error(
          result?.error?.message ||
            "The Panelavo plugin package is not available on this panel.",
        );
      }
      const href = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = "panelavo-plugin.zip";
      anchor.click();
      URL.revokeObjectURL(href);
      toast.success("Panelavo plugin downloaded");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The Panelavo plugin package could not be downloaded.",
      );
    } finally {
      setDownloading(false);
    }
  }

  async function disconnect() {
    if (!disconnecting) return;
    setBusy(true);
    try {
      const response = await fetch(apiBase, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: disconnecting.id }),
      });
      const result = await response.json();
      if (!result.success)
        throw new Error(
          result.error?.message || "The assistant could not be disconnected.",
        );
      setConnections((current) =>
        Array.isArray(result.data)
          ? result.data
          : current.filter((item) => item.id !== disconnecting.id),
      );
      toast.success("AI assistant disconnected");
      setDisconnecting(null);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The assistant could not be disconnected.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <section className="overflow-hidden rounded-2xl border border-panel-100 bg-gradient-to-br from-panel-50 via-white to-indigo-50 shadow-card">
        <div className="grid gap-6 p-5 sm:p-7 lg:grid-cols-[1fr_auto] lg:items-center">
          <div className="flex items-start gap-4">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-panel-600 text-white shadow-sm">
              <Bot className="h-6 w-6" />
            </span>
            <div>
              <h2 className="text-2xl font-bold tracking-tight text-ink">
                Add Panelavo to ChatGPT
              </h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                Download the Panelavo plugin, add it to ChatGPT, and sign in in
                your browser. The plugin includes the connection and the
                guidance needed to manage websites safely.
              </p>
            </div>
          </div>
          <div className="rounded-2xl border border-white/80 bg-white/80 p-4 shadow-sm backdrop-blur">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Your access
            </p>
            <p className="mt-1 flex items-center gap-2 font-bold text-ink">
              <ShieldCheck className="h-4 w-4 text-panel-600" /> {access.title}
            </p>
            <p className="mt-1 max-w-xs text-xs leading-5 text-slate-500">
              {access.detail}
            </p>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-white/60 bg-white/70 shadow-card backdrop-blur-md">
        <div className="border-b border-slate-200/70 px-5 py-4 sm:px-6">
          <h3 className="flex items-center gap-2 font-bold text-ink">
            <Download className="h-4 w-4 text-panel-600" /> Install the
            Panelavo plugin
          </h3>
          <p className="mt-1 text-sm text-slate-500">
            No server address or access token needs to be copied.
          </p>
        </div>
        <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <ol className="space-y-5">
            <NumberedStep number={1} title="Download the plugin">
              Save the ZIP file without extracting it.
              <div className="mt-3">
                <Button
                  type="button"
                  disabled={downloading}
                  onClick={() => void downloadPlugin()}
                >
                  {downloading ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  Download Panelavo plugin
                </Button>
                <p className="mt-2 text-xs leading-5 text-slate-400">
                  Panelavo verifies that this panel&apos;s hosted connection
                  service is enabled before creating the ZIP. If it is not
                  ready, the download explains the administrator prerequisite.
                </p>
              </div>
            </NumberedStep>
            <NumberedStep number={2} title="Add it to ChatGPT">
              Open ChatGPT settings, choose Plugins, upload the downloaded ZIP,
              then open Panelavo and choose Connect.
            </NumberedStep>
            <NumberedStep number={3} title="Connect your servers">
              The secure browser page lets you add each Panelavo server
              independently using that server&apos;s normal sign-in. Add another
              server later from the same connection page. Never paste a
              Panelavo password or token into chat.
            </NumberedStep>
          </ol>
          <div className="max-w-sm rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 text-sm leading-6 text-emerald-800">
            <p className="font-semibold">Uses live Panelavo permissions</p>
            <p className="mt-1">
              Each server checks your current role and website assignments on
              every request. Existing compatible browser connections and
              access grants keep working until they expire or you disconnect
              them.
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/60 bg-white/70 p-5 shadow-card backdrop-blur-md sm:p-6">
        <h3 className="flex items-center gap-2 font-bold text-ink">
          <Server className="h-4 w-4 text-panel-600" /> How Panelavo keeps
          deployments aligned
        </h3>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm leading-6 text-slate-600">
            <b className="text-slate-800">Site ID and port</b>
            <p className="mt-1">
              A new app defaults to the same port as its site ID: site 20004
              starts on port 20004. Existing sites keep their current CloudPanel
              upstream unless you explicitly change it.
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm leading-6 text-slate-600">
            <b className="text-slate-800">App binding</b>
            <p className="mt-1">
              Apps read PORT and listen on 127.0.0.1. Docker publishes only the
              configured host port on 127.0.0.1. A custom upstream is an
              exceptional fallback.
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm leading-6 text-slate-600">
            <b className="text-slate-800">Safe verification</b>
            <p className="mt-1">
              The plugin checks permissions, backups, app health, listener
              ownership, proxy response, and the public website, and reports
              verification warnings separately from application health.
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/60 bg-white/70 p-5 shadow-card backdrop-blur-md sm:p-6">
        <h3 className="flex items-center gap-2 font-bold text-ink">
          <Plug className="h-4 w-4 text-panel-600" /> Try asking
        </h3>
        <p className="mt-1 text-sm text-slate-500">
          Replace example.com with one of your websites.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {prompts.map((prompt) => (
            <CopyValue
              key={prompt}
              value={prompt}
              className="w-full justify-between rounded-xl border border-slate-200 bg-white p-4 text-sm leading-6 text-slate-700 hover:border-panel-300 hover:bg-panel-50/50"
            >
              {prompt}
            </CopyValue>
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-white/60 bg-white/70 shadow-card backdrop-blur-md">
        <div className="flex items-start gap-3 border-b border-slate-200/70 px-5 py-4 sm:px-6">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-panel-50 text-panel-600">
            <KeyRound className="h-4 w-4" />
          </span>
          <div>
            <h3 className="font-bold text-ink">Existing AI connections</h3>
            <p className="mt-0.5 text-sm text-slate-500">
              Existing compatible connections remain available. Disconnect
              only the access you no longer want.
            </p>
          </div>
        </div>
        {connections.length ? (
          <div className="divide-y divide-slate-100">
            {connections.map((connection) => (
              <article
                key={connection.id}
                className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-semibold text-slate-800">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                    <span className="truncate">
                      {connection.clientName || "AI assistant"}
                    </span>
                  </p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    {connection.kind === "personal-token"
                      ? "Existing access grant"
                      : "Browser sign-in"}{" "}
                    · Connected {formatDate(connection.createdAt)} · Last used{" "}
                    {formatDate(connection.lastUsedAt)} · Expires{" "}
                    {formatDate(connection.expiresAt)}
                  </p>
                  <p className="text-xs leading-5 text-slate-400">
                    Current access: {access.title.toLowerCase()}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="text-red-600 hover:bg-red-50"
                  onClick={() => setDisconnecting(connection)}
                >
                  <Trash2 className="h-4 w-4" /> Disconnect
                </Button>
              </article>
            ))}
          </div>
        ) : (
          <div className="px-5 py-10 text-center sm:px-6">
            <Plug className="mx-auto h-8 w-8 text-slate-300" />
            <p className="mt-3 font-semibold text-slate-700">
              No existing AI connections
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Install the plugin above and choose Connect in ChatGPT.
            </p>
          </div>
        )}
      </section>

      {disconnecting ? (
        <ConfirmDialog
          title={`Disconnect ${disconnecting.clientName || "this assistant"}?`}
          message="It will stop working immediately. Your Panelavo account and websites will not be changed."
          confirmText={busy ? "Disconnecting…" : "Disconnect"}
          onCancel={() => {
            if (!busy) setDisconnecting(null);
          }}
          onConfirm={() => {
            if (!busy) void disconnect();
          }}
        />
      ) : null}
    </div>
  );
}
