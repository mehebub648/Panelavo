"use client";

import { useState } from "react";
import { Copy, KeyRound, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { PublicApiToken } from "@/server/auth/api-tokens";

export function ApiTokenManager({
  initialTokens,
}: {
  initialTokens: PublicApiToken[];
}) {
  const [tokens, setTokens] = useState(initialTokens);
  const [name, setName] = useState("");
  const [write, setWrite] = useState(false);
  const [days, setDays] = useState("90");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  async function create() {
    setBusy("create");
    try {
      const response = await fetch("/api/profile/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          scopes: write ? ["sites:read", "sites:write"] : ["sites:read"],
          ...(days === "never" ? {} : { expiresInDays: Number(days) }),
        }),
      });
      const result = await response.json();
      if (!result.success)
        throw new Error(result.error?.message || "Token could not be created.");
      setTokens([result.data.record, ...tokens]);
      setRevealed(result.data.token);
      setName("");
      toast.success("API token created");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Token could not be created.",
      );
    } finally {
      setBusy(null);
    }
  }
  async function revoke(id: string) {
    setBusy(id);
    try {
      const response = await fetch("/api/profile/tokens", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const result = await response.json();
      if (!result.success)
        throw new Error(result.error?.message || "Token could not be revoked.");
      setTokens(result.data);
      toast.success("API token revoked");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Token could not be revoked.",
      );
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="overflow-hidden rounded-2xl border border-white/40 bg-white/60 shadow-card backdrop-blur-md">
      <div className="border-b border-slate-200/50 bg-slate-50/40 px-5 py-4 sm:px-6">
        <h3 className="flex items-center gap-2 font-bold">
          <KeyRound className="h-4 w-4 text-panel-600" /> API tokens
        </h3>
        <p className="mt-0.5 text-sm text-slate-500">
          Scoped credentials for the versioned automation API.
        </p>
      </div>
      <div className="space-y-4 p-5 sm:p-6">
        {revealed && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-900">
              Copy this token now. It will not be shown again.
            </p>
            <div className="mt-2 flex gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-white p-2 text-xs">
                {revealed}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(revealed);
                  toast.success("Copied");
                }}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-[1fr_150px_auto] sm:items-end">
          <div>
            <Label htmlFor="token-name">Token name</Label>
            <Input
              id="token-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="CI deployment"
              className="mt-1.5"
            />
          </div>
          <div>
            <Label htmlFor="token-expiry">Expires</Label>
            <Select
              id="token-expiry"
              value={days}
              onChange={(event) => setDays(event.target.value)}
              className="mt-1.5"
            >
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="365">1 year</option>
              <option value="never">Never</option>
            </Select>
          </div>
          <Button disabled={busy !== null || !name.trim()} onClick={create}>
            {busy === "create" ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}{" "}
            Create
          </Button>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={write}
            onChange={(event) => setWrite(event.target.checked)}
          />{" "}
          Allow site changes and deployments (read access is always included)
        </label>
      </div>
      <div className="divide-y divide-slate-100 border-t border-slate-100">
        {tokens.map((token) => (
          <div
            key={token.id}
            className="flex items-center justify-between gap-4 px-5 py-3 text-sm sm:px-6"
          >
            <div>
              <p className="font-medium text-slate-700">{token.name}</p>
              <p className="text-xs text-slate-500">
                {token.scopes.join(", ")} ·{" "}
                {token.expiresAt
                  ? `expires ${new Date(token.expiresAt).toLocaleDateString()}`
                  : "never expires"}
                {token.lastUsedAt
                  ? ` · used ${new Date(token.lastUsedAt).toLocaleString()}`
                  : ""}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => revoke(token.id)}
            >
              {busy === token.id ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
