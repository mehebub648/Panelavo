"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, Link2, Server } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Connection = {
  id: string;
  label: string;
  origin: string;
  status: string;
  fullAccess: boolean;
};
type Connections = { outgoing: Connection[]; incoming: Connection[] };

async function update(apiBase: string, input: unknown) {
  const response = await fetch(`${apiBase}/api/connections`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!result.success)
    throw new Error(
      result.error?.message || "The connection could not be updated.",
    );
  return result.data;
}

export function ConnectedServers({ apiBase = "" }: { apiBase?: string }) {
  const [connections, setConnections] = useState<Connections>({
    outgoing: [],
    incoming: [],
  });
  const [mode, setMode] = useState<"generate" | "submit" | null>(null);
  const [token, setToken] = useState("");
  const [generated, setGenerated] = useState<{
    token: string;
    expiresAt: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  let tokenServer = "";
  try {
    const decoded = JSON.parse(
      atob(token.trim().slice(10).replace(/-/g, "+").replace(/_/g, "/")),
    );
    if (
      token.trim().startsWith("pnl_fleet_") &&
      typeof decoded.hubOrigin === "string"
    )
      tokenServer = new URL(decoded.hubOrigin).hostname;
  } catch {
    /* The server validates the complete token on submission. */
  }
  const load = useCallback(async () => {
    const response = await fetch(`${apiBase}/api/connections`, {
      cache: "no-store",
    });
    const result = await response.json();
    if (!result.success)
      throw new Error(
        result.error?.message || "Connections could not be loaded.",
      );
    setConnections(result.data);
    if (!apiBase)
      window.dispatchEvent(new Event("panelavo-connections-changed"));
  }, [apiBase]);
  useEffect(() => {
    void load().catch((reason) => setError(reason.message));
  }, [load]);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Connection failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      id="connected-servers"
      className="scroll-mt-24 rounded-2xl border border-slate-200 bg-white p-5 shadow-card sm:p-6"
    >
      <div className="flex items-center gap-3">
        <Server className="h-5 w-5 text-panel-600" />
        <h3 className="font-bold">Connected servers</h3>
      </div>
      <p className="mt-2 text-sm text-slate-500">
        Manage your servers here with one sign-in. Only Super Admins can connect
        and switch servers.
      </p>
      <div className="mt-5 flex flex-wrap gap-3">
        <Button
          disabled={busy}
          onClick={() => {
            setMode("generate");
            void run(async () => {
              setGenerated(await update(apiBase, { action: "generate-token" }));
            });
          }}
        >
          <KeyRound className="h-4 w-4" />
          Generate token
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setMode("submit");
            setGenerated(null);
          }}
        >
          <Link2 className="h-4 w-4" />I have a token
        </Button>
      </div>
      {mode === "generate" && generated && (
        <div className="mt-4 space-y-3 rounded-xl bg-slate-50 p-4">
          <p className="text-sm">
            Submit this token in the other server’s Settings to manage that
            server with full Super Admin access from here. Use a separate token
            for each server.
          </p>
          <textarea
            aria-label="Connection token"
            readOnly
            value={generated.token}
            className="w-full rounded-lg border border-slate-200 p-3 font-mono text-xs"
            rows={3}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-500">
              Single use · expires at{" "}
              {new Date(generated.expiresAt).toLocaleTimeString()}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void navigator.clipboard
                  .writeText(generated.token)
                  .then(() => toast.success("Token copied"))
                  .catch(() =>
                    toast.error("Select and copy the token manually."),
                  )
              }
            >
              <Copy className="h-4 w-4" />
              Copy token
            </Button>
          </div>
        </div>
      )}
      {mode === "submit" && (
        <form
          className="mt-4 space-y-3 rounded-xl bg-slate-50 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await update(apiBase, { action: "submit-token", token });
              setToken("");
              setMode(null);
              await load();
              toast.success("Server connected");
            });
          }}
        >
          <p className="text-sm">
            Pasting a token allows the server that generated it to manage this
            server with full Super Admin access as your account, including
            users, settings, credentials, and security controls. Only submit a
            token from a server you trust with complete administration of this
            server.
          </p>
          <textarea
            aria-label="Paste connection token"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            className="w-full rounded-lg border border-slate-200 p-3 font-mono text-xs"
            rows={3}
            placeholder="Paste your token"
            autoComplete="off"
            spellCheck={false}
          />
          {tokenServer && (
            <p className="break-all text-sm font-semibold text-panel-700">
              Allow access from {tokenServer}
            </p>
          )}
          <Button disabled={busy || !token.trim()} type="submit">
            Connect server
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error}
        </p>
      )}
      {(["outgoing", "incoming"] as const).map(
        (direction) =>
          connections[direction].length > 0 && (
            <div key={direction} className="mt-6 space-y-3">
              <h4 className="text-sm font-semibold">
                {direction === "outgoing"
                  ? "Servers you can switch to"
                  : "Servers allowed to manage this server"}
              </h4>
              {connections[direction].map((connection) => (
                <ConnectionRow
                  key={connection.id}
                  connection={connection}
                  busy={busy}
                  onSave={(nickname) =>
                    void run(async () => {
                      await update(apiBase, {
                        action: "rename",
                        id: connection.id,
                        nickname,
                      });
                      await load();
                    })
                  }
                  onDisconnect={() => {
                    if (
                      window.prompt(
                        `Type DISCONNECT SERVER to remove access for ${connection.label}. Websites and services will not change.`,
                      ) !== "DISCONNECT SERVER"
                    )
                      return;
                    void run(async () => {
                      await update(apiBase, {
                        action: "disconnect",
                        id: connection.id,
                        direction,
                        confirmation: "DISCONNECT SERVER",
                      });
                      await load();
                    });
                  }}
                />
              ))}
            </div>
          ),
      )}
    </section>
  );
}

function ConnectionRow({
  connection,
  busy,
  onSave,
  onDisconnect,
}: {
  connection: Connection;
  busy: boolean;
  onSave: (value: string) => void;
  onDisconnect: () => void;
}) {
  const [nickname, setNickname] = useState(connection.label);
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label={`Nickname for ${connection.origin}`}
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          maxLength={100}
          className="min-w-0 flex-1"
        />
        <Button
          variant="outline"
          size="sm"
          disabled={busy || nickname === connection.label}
          onClick={() => onSave(nickname)}
        >
          Save name
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={onDisconnect}
        >
          Disconnect
        </Button>
      </div>
      <p className="mt-2 break-all text-xs text-slate-500">
        {connection.origin} · {connection.status}
      </p>
      {!connection.fullAccess && (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Limited connection from an older release. Disconnect it, then submit a
          newly generated token to authorize the matching full panel.
        </p>
      )}
    </div>
  );
}
