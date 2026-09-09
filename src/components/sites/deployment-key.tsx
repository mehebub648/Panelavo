"use client";
import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export function DeploymentKey({
  domain,
  apiBase,
}: {
  domain: string;
  apiBase: string;
}) {
  const [key, setKey] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const base = `${apiBase}/api/sites/${encodeURIComponent(domain)}/sections/users`;
  useEffect(() => {
    fetch(base)
      .then((response) => response.json())
      .then((result) => {
        if (!result.success)
          throw new Error(
            result.error?.message || "Could not load the deployment key.",
          );
        setKey(result.data.keyPair?.publicKey || "");
      })
      .catch((reason) => setError(reason.message));
  }, [base]);
  async function generate() {
    setBusy(true);
    setError("");
    try {
      const result = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "generate-keypair" }),
      }).then((response) => response.json());
      if (!result.success)
        throw new Error(
          result.error?.message || "Could not create the deployment key.",
        );
      setKey(result.data.keyPair?.publicKey || "");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not create the deployment key.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="my-4 space-y-2 rounded-xl border bg-white p-4">
      <h4 className="text-sm font-semibold">Repository access</h4>
      <p className="text-xs text-slate-500">
        Add this public key as a read-only deploy key in your repository
        settings, then use its SSH URL. Enable repository write access only if
        you use Push.
      </p>
      {key ? (
        <>
          <code className="block break-all rounded bg-slate-50 p-3 text-xs">
            {key}
          </code>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void navigator.clipboard.writeText(key)}
          >
            Copy public key
          </Button>
        </>
      ) : key === "" ? (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void generate()}
        >
          Create deployment key
        </Button>
      ) : (
        <p className="text-xs">{error || "Loading public key…"}</p>
      )}
      {error && key !== undefined && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
