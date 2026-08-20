"use client";

import React, { useRef, useState } from "react";
import {
  Bot,
  CheckCircle2,
  CircleHelp,
  ExternalLink,
  KeyRound,
  Laptop,
  LoaderCircle,
  MonitorCog,
  Plug,
  Plus,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { CloudPanelUser, PanelRole } from "@/types/cloudpanel";
import type { PublicMcpConnection } from "@/server/mcp/oauth";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyValue } from "@/components/ui/copy-value";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Guide = "windows" | "unix" | "manual";

const guides: Array<{
  id: Guide;
  label: string;
  icon: typeof Laptop;
}> = [
  { id: "windows", label: "Windows", icon: MonitorCog },
  { id: "unix", label: "macOS / Linux", icon: TerminalSquare },
  { id: "manual", label: "Other MCP apps", icon: Laptop },
];

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

function CopyBlock({ value, label }: { value: string; label?: string }) {
  return (
    <CopyValue
      value={value}
      className="mt-2 flex w-full items-start justify-between gap-3 rounded-xl border border-slate-200 bg-slate-950 px-4 py-3 text-slate-100 hover:bg-slate-900"
    >
      <span className="block min-w-0">
        {label ? (
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {label}
          </span>
        ) : null}
        <code className="block whitespace-pre-wrap break-all text-left text-xs leading-5">
          {value}
        </code>
      </span>
    </CopyValue>
  );
}

function SetupSteps({
  guide,
  endpoint,
  token,
}: {
  guide: Guide;
  endpoint: string;
  token: string | null;
}) {
  const secret = token ?? "<TOKEN_FROM_STEP_1>";
  if (guide === "windows") {
    const commands = `[Environment]::SetEnvironmentVariable("PANELAVO_MCP_TOKEN", "${secret}", "User")\n$env:PANELAVO_MCP_TOKEN = "${secret}"\ncodex mcp add panelavo --url ${endpoint} --bearer-token-env-var PANELAVO_MCP_TOKEN\ncodex mcp list`;
    return (
      <ol className="space-y-5">
        <NumberedStep number={2} title="Run the ready-made setup">
          Open PowerShell and run these commands. They save the token for your
          Windows account and add Panelavo to Codex.
          <CopyBlock value={commands} label="PowerShell commands" />
        </NumberedStep>
        <NumberedStep number={3} title="Check the connection">
          Restart Codex, then type <code>/mcp</code>. Use <code>codex.cmd</code>
          instead if PowerShell says scripts are disabled.
        </NumberedStep>
      </ol>
    );
  }

  if (guide === "unix") {
    const commands = `export PANELAVO_MCP_TOKEN='${secret}'\ncodex mcp add panelavo --url ${endpoint} --bearer-token-env-var PANELAVO_MCP_TOKEN\ncodex mcp list`;
    return (
      <ol className="space-y-5">
        <NumberedStep number={2} title="Add the token and server">
          Open a terminal and run these commands. Add the environment variable
          to your normal secure shell setup if you want it available after a
          restart.
          <CopyBlock value={commands} label="Terminal commands" />
        </NumberedStep>
        <NumberedStep number={3} title="Check the connection">
          Restart Codex, then type <code>/mcp</code> and check that Panelavo is
          connected.
        </NumberedStep>
      </ol>
    );
  }

  return (
    <ol className="space-y-5">
      <NumberedStep number={2} title="Enter the MCP connection details">
        Choose <b>Streamable HTTP</b> and use this server address.
        <CopyBlock value={endpoint} label="Server address" />
        <CopyBlock value={secret} label="Bearer token" />
      </NumberedStep>
      <NumberedStep number={3} title="Use bearer authentication">
        If the app asks for a header, use <code>Authorization</code> with the
        value <code>Bearer &lt;your token&gt;</code>. Save, restart the app if
        requested, and test the connection.
      </NumberedStep>
    </ol>
  );
}

function formatDate(value: string | number | undefined) {
  if (!value) return "Not used yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

export function McpSetupGuide({
  user,
  endpoint,
  initialConnections,
}: {
  user: CloudPanelUser;
  endpoint: string;
  initialConnections: PublicMcpConnection[];
}) {
  const [guide, setGuide] = useState<Guide>("windows");
  const [connections, setConnections] = useState(initialConnections);
  const [tokenName, setTokenName] = useState("My Codex");
  const [tokenDays, setTokenDays] = useState("90");
  const [createdToken, setCreatedToken] = useState<{
    value: string;
    connectionId: string;
  } | null>(null);
  const [creatingToken, setCreatingToken] = useState(false);
  const [disconnecting, setDisconnecting] =
    useState<PublicMcpConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const tabRefs = useRef<Partial<Record<Guide, HTMLButtonElement | null>>>({});
  const access = mcpAccessSummary(user.panelRole);
  const prompts = [
    "Show the websites I can access and tell me which need attention.",
    "Check example.com and explain any deployment blockers. Do not change anything yet.",
    "Create an on-server backup of example.com, then deploy its recommended plan.",
    "Show the current runtime status for example.com without changing anything.",
  ];

  async function createToken() {
    setCreatingToken(true);
    try {
      const response = await fetch("/api/profile/mcp-connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: tokenName,
          expiresInDays: Number(tokenDays),
        }),
      });
      const result = await response.json();
      if (!result.success)
        throw new Error(
          result.error?.message || "The access token could not be created.",
        );
      setCreatedToken({
        value: result.data.token,
        connectionId: result.data.connection.id,
      });
      setConnections((current) => [result.data.connection, ...current]);
      toast.success("MCP access token created");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The access token could not be created.",
      );
    } finally {
      setCreatingToken(false);
    }
  }

  function chooseFromKeyboard(
    event: React.KeyboardEvent<HTMLButtonElement>,
    current: Guide,
  ) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = guides.findIndex((item) => item.id === current);
    const next =
      event.key === "Home"
        ? guides[0]
        : event.key === "End"
          ? guides.at(-1)!
          : guides[
              (index + (event.key === "ArrowRight" ? 1 : -1) + guides.length) %
                guides.length
            ];
    setGuide(next.id);
    tabRefs.current[next.id]?.focus();
  }

  async function disconnect() {
    if (!disconnecting) return;
    setBusy(true);
    try {
      const response = await fetch("/api/profile/mcp-connections", {
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
      if (createdToken?.connectionId === disconnecting.id)
        setCreatedToken(null);
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
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-2xl font-bold tracking-tight text-ink">
                  Connect an AI assistant
                </h2>
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-600/20">
                  Uses your current access
                </span>
              </div>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                Connect Codex or another MCP-compatible assistant to Panelavo.
                For supported website tools, it can see and do only what your
                account can. If your role or website assignments change, its
                access changes too.
              </p>
              <p className="mt-2 flex items-start gap-2 text-xs leading-5 text-slate-500">
                <CircleHelp className="mt-0.5 h-3.5 w-3.5 shrink-0" /> MCP is
                the secure connection used behind the scenes. You do not need to
                understand it to get started.
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

      <section className="rounded-2xl border border-white/60 bg-white/70 p-5 shadow-card backdrop-blur-md sm:p-6">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-panel-50 text-panel-600">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <div>
            <h3 className="font-bold text-ink">
              What your assistant can access
            </h3>
            <p className="mt-1 text-sm leading-6 text-slate-500">
              {access.detail} The tools available today can inspect websites,
              Git and runtime state; manage site settings and files; run
              deployments and backups; and perform the same supported server
              actions available for your websites.
            </p>
          </div>
        </div>
        <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm leading-6 text-emerald-800">
          Your assistant does not receive a separate administrator account. It
          works as you and never bypasses Panelavo permissions or safety checks.
          Disabling your account or removing a website assignment blocks that
          access immediately. Account security, Panelavo account management, and
          panel settings stay in the Panelavo interface. Sensitive website
          actions may still ask for confirmation.
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-white/60 bg-white/70 shadow-card backdrop-blur-md">
        <div className="border-b border-slate-200/70 px-5 py-4 sm:px-6">
          <h3 className="flex items-center gap-2 font-bold text-ink">
            <Plug className="h-4 w-4 text-panel-600" /> Quick MCP setup
          </h3>
          <p className="mt-1 text-sm text-slate-500">
            Create a token, then copy the setup for your computer. Codex
            desktop, the command line, and the IDE share this connection.
          </p>
        </div>
        <div className="space-y-6 p-5 sm:p-6">
          <div className="rounded-2xl border border-panel-100 bg-panel-50/50 p-4 sm:p-5">
            <div className="flex gap-3">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-panel-100 text-xs font-bold text-panel-700">
                1
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-800">
                  Create your access token
                </p>
                <p className="mt-1 text-sm leading-6 text-slate-500">
                  Give this connection a recognizable name. The token uses your
                  live Panelavo access and can be revoked at any time.
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_150px_auto] sm:items-end">
                  <div>
                    <Label htmlFor="mcp-token-name">Connection name</Label>
                    <Input
                      id="mcp-token-name"
                      value={tokenName}
                      onChange={(event) => setTokenName(event.target.value)}
                      maxLength={80}
                      placeholder="My Codex"
                      className="mt-1.5 bg-white"
                    />
                  </div>
                  <div>
                    <Label htmlFor="mcp-token-expiry">Expires</Label>
                    <Select
                      id="mcp-token-expiry"
                      value={tokenDays}
                      onChange={(event) => setTokenDays(event.target.value)}
                      className="mt-1.5 bg-white"
                    >
                      <option value="30">30 days</option>
                      <option value="90">90 days</option>
                      <option value="365">1 year</option>
                    </Select>
                  </div>
                  <Button
                    type="button"
                    disabled={creatingToken || !tokenName.trim()}
                    onClick={() => void createToken()}
                  >
                    {creatingToken ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="h-4 w-4" />
                    )}
                    Generate token
                  </Button>
                </div>
                {createdToken ? (
                  <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
                    <p className="text-sm font-semibold text-amber-900">
                      Copy this token now. Panelavo will not show it again.
                    </p>
                    <p className="mt-1 text-xs leading-5 text-amber-800">
                      Treat it like a password. Creating another token does not
                      revoke this one.
                    </p>
                    <CopyBlock
                      value={createdToken.value}
                      label="Bearer token"
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          <div
            role="tablist"
            aria-label="AI assistant setup method"
            className="grid gap-2 rounded-xl bg-slate-100 p-1 sm:grid-cols-3"
          >
            {guides.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                ref={(element) => {
                  tabRefs.current[id] = element;
                }}
                type="button"
                role="tab"
                id={`setup-tab-${id}`}
                aria-selected={guide === id}
                aria-controls={`setup-panel-${id}`}
                tabIndex={guide === id ? 0 : -1}
                onClick={() => setGuide(id)}
                onKeyDown={(event) => chooseFromKeyboard(event, id)}
                className={cn(
                  "flex h-10 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-panel-500",
                  guide === id
                    ? "bg-white text-panel-700 shadow-sm"
                    : "text-slate-500 hover:text-slate-800",
                )}
              >
                <Icon className="h-4 w-4" /> {label}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id={`setup-panel-${guide}`}
            aria-labelledby={`setup-tab-${guide}`}
            className="mt-6 max-w-3xl"
          >
            <SetupSteps
              guide={guide}
              endpoint={endpoint}
              token={createdToken?.value ?? null}
            />
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/60 bg-white/70 p-5 shadow-card backdrop-blur-md sm:p-6">
        <h3 className="flex items-center gap-2 font-bold text-ink">
          <Sparkles className="h-4 w-4 text-panel-600" /> Try asking
        </h3>
        <p className="mt-1 text-sm text-slate-500">
          Replace example.com with one of your websites. Click a prompt to copy
          it.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {prompts.map((prompt) => (
            <CopyValue
              key={prompt}
              value={prompt}
              className="hover:border-panel-300 w-full justify-between rounded-xl border border-slate-200 bg-white p-4 text-sm leading-6 text-slate-700 hover:bg-panel-50/50"
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
            <h3 className="font-bold text-ink">Connected assistants</h3>
            <p className="mt-0.5 text-sm text-slate-500">
              Review or disconnect access tokens and browser-approved apps.
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
                      ? "Access token"
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
              No AI assistants are connected yet
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Follow the setup guide above to connect your first assistant.
            </p>
          </div>
        )}
      </section>

      <details className="rounded-2xl border border-slate-200 bg-white/70 shadow-sm">
        <summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-slate-700 sm:px-6">
          Advanced connection details
        </summary>
        <div className="space-y-4 border-t border-slate-100 px-5 py-5 sm:px-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              MCP endpoint
            </p>
            <CopyBlock value={endpoint} />
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-600">
            <span>
              <b className="text-slate-700">Connection:</b> Streamable HTTP
            </span>
            <span>
              <b className="text-slate-700">Recommended:</b> Bearer access token
            </span>
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-700">
              Browser sign-in alternative
            </p>
            <p className="mt-1 text-sm leading-6 text-slate-500">
              Clients that support MCP OAuth can connect without a manually
              managed token. Add the server, then open Panelavo to approve it.
            </p>
            <CopyBlock
              value={`codex mcp add panelavo --url ${endpoint}\ncodex mcp login panelavo`}
              label="OAuth commands"
            />
          </div>
          <a
            href="https://developers.openai.com/codex/mcp"
            target="_blank"
            rel="noreferrer"
            className="hover:text-panel-800 inline-flex items-center gap-1.5 text-sm font-semibold text-panel-700"
          >
            Open the official Codex MCP guide
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </details>

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
