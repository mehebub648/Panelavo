"use client";

import React, { useEffect, useState } from "react";
import { Globe2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function PanelAddress({ apiBase = "" }: { apiBase?: string }) {
  const [current, setCurrent] = useState("");
  const [origin, setOrigin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    void fetch(`${apiBase}/api/panel-address`, { cache: "no-store" })
      .then((response) => response.json())
      .then((result) => {
        if (!result.success)
          throw new Error(
            result.error?.message || "Could not load the panel address.",
          );
        setCurrent(result.data.origin);
        setOrigin(result.data.pendingOrigin || "");
        setPending(Boolean(result.data.pendingOrigin));
      })
      .catch((reason) => setError(reason.message));
  }, [apiBase]);
  let hostname = "";
  try {
    hostname = new URL(origin).hostname;
  } catch {
    /* validated on submission */
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`${apiBase}/api/panel-address`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin, confirmation }),
      });
      const result = await response.json();
      if (!result.success)
        throw new Error(
          result.error?.message || "The panel address could not be changed.",
        );
      setPending(result.data.pending);
      if (result.data.pending)
        setMessage(
          `${result.data.remaining} connected server(s) still need to acknowledge the new address. Keep both domains working, ensure every peer runs v0.1.118 or newer, then retry. Your current address remains active.`,
        );
      else {
        setCurrent(result.data.origin);
        setOrigin("");
        setConfirmation("");
        setMessage(
          "Panel address updated. Connected-server identities and access are preserved. Keep the previous domain available for existing links.",
        );
      }
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Address change failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card sm:p-6">
      <div className="flex items-center gap-3">
        <Globe2 className="h-5 w-5 text-panel-600" />
        <h3 className="font-bold">Panel address</h3>
      </div>
      <p className="mt-2 break-all text-sm font-medium text-panel-700">
        {current || "Loading current address…"}
      </p>
      <p className="mt-3 text-sm leading-6 text-slate-500">
        Use your own domain without reconnecting servers. First point its DNS to
        this server, add it to this panel’s CloudPanel site, and install a valid
        HTTPS certificate. Keep the existing address working during the change.
        This does not rename website domains or move files.
      </p>
      <form onSubmit={save} className="mt-5 space-y-4">
        <label className="block text-sm font-medium">
          New panel address
          <Input
            className="mt-2"
            placeholder="https://panel.example.com"
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
            disabled={busy || pending}
            required
          />
        </label>
        <label className="block text-sm font-medium">
          Type {hostname || "the new hostname"} to confirm
          <Input
            className="mt-2"
            autoComplete="off"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            disabled={busy}
            required
          />
        </label>
        <p className="text-xs leading-5 text-slate-500">
          You will sign in once on the new domain. Personal API/OAuth clients
          may need reconnection; server switching keeps its existing keys and
          permissions.
        </p>
        <Button
          disabled={busy || !current || !hostname || confirmation !== hostname}
          type="submit"
        >
          {busy
            ? "Verifying and notifying servers…"
            : pending
              ? "Retry address change"
              : "Verify and change address"}
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-4 text-sm text-red-600">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mt-4 text-sm leading-6 text-panel-700">
          {message}
        </p>
      )}
    </section>
  );
}
