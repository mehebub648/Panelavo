"use client";
import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { PublicApiToken } from "@/server/auth/api-tokens";

export function AutomaticDeployment({
  domain,
  apiBase,
  branch,
}: {
  domain: string;
  apiBase: string;
  branch: string;
}) {
  const base = `${apiBase}/api/sites/${encodeURIComponent(domain)}/deployment-tokens`;
  const [tokens, setTokens] = useState<PublicApiToken[]>([]);
  const [secret, setSecret] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch(base)
      .then((response) => response.json())
      .then((result) => {
        if (!result.success)
          throw new Error(
            result.error?.message || "Could not load deployment tokens.",
          );
        setTokens(result.data.tokens);
        setEndpoint(result.data.endpoint);
      })
      .catch((reason) => setError(reason.message));
  }, [base]);
  async function manage(input: object) {
    setBusy(true);
    setError("");
    try {
      const result = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }).then((response) => response.json());
      if (!result.success)
        throw new Error(
          result.error?.message || "Could not update deployment tokens.",
        );
      if (result.data.token) {
        setSecret(result.data.token);
        setTokens((current) => [result.data.record, ...current]);
      } else setTokens(result.data.tokens);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not update deployment tokens.",
      );
    } finally {
      setBusy(false);
    }
  }
  const workflow = `# Add this job to the workflow that checks commits on ${branch || "your deployment branch"}.
# Replace "checks" with your existing test/build job ID.
deploy:
  needs: checks
  if: github.event_name == 'push' && github.ref == 'refs/heads/${branch || "main"}'
  runs-on: ubuntu-latest
  environment: production
  timeout-minutes: 35
  concurrency:
    group: panelavo-${domain}
    cancel-in-progress: false
  steps:
    - name: Deploy the tested commit
      env:
        DEPLOY_URL: \${{ secrets.PANELAVO_DEPLOY_URL }}
        DEPLOY_TOKEN: \${{ secrets.PANELAVO_DEPLOY_TOKEN }}
        BRANCH: \${{ github.ref_name }}
        COMMIT: \${{ github.sha }}
        REQUEST_ID: \${{ github.run_id }}-\${{ github.run_attempt }}
      run: |
        set -euo pipefail
        payload=$(jq -n --arg branch "$BRANCH" --arg expectedCommit "$COMMIT" '{branch:$branch,expectedCommit:$expectedCommit}')
        response=$(curl --fail-with-body --silent --show-error --max-time 30 \\
          -H "Authorization: Bearer $DEPLOY_TOKEN" -H 'Content-Type: application/json' \\
          -H "Idempotency-Key: github-$REQUEST_ID" --data "$payload" "$DEPLOY_URL")
        id=$(jq -er '.data.id' <<< "$response")
        for attempt in $(seq 1 900); do
          response=$(curl --fail-with-body --silent --show-error --max-time 30 -H "Authorization: Bearer $DEPLOY_TOKEN" "$DEPLOY_URL/$id")
          status=$(jq -er '.data.status' <<< "$response")
          case "$status" in
            succeeded) echo 'Deployment succeeded'; exit 0 ;;
            queued|running) sleep 2 ;;
            *) echo "Deployment $status. Review its result in Panelavo."; exit 1 ;;
          esac
        done
        echo 'Stopped waiting. Check the saved deployment result in Panelavo.'
        exit 1`;
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Create a token for this website and save it in your CI secret named{" "}
        <code>PANELAVO_DEPLOY_TOKEN</code>. Tokens expire after 90 days and can
        be revoked below.
      </p>
      {endpoint && (
        <p className="break-all text-xs">
          Set <code>PANELAVO_DEPLOY_URL</code> to <code>{endpoint}</code>.
        </p>
      )}
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => void manage({ action: "create", name: "CI deployment" })}
      >
        Create deployment token
      </Button>
      {secret && (
        <div className="space-y-2 rounded-lg bg-amber-50 p-3">
          <p className="text-sm font-medium">
            Copy this token now. It is shown only once.
          </p>
          <code className="block break-all text-xs">{secret}</code>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigator.clipboard.writeText(secret)}
          >
            Copy token
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSecret("")}>
            Hide token
          </Button>
        </div>
      )}
      {tokens.map((token) => (
        <div
          key={token.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2 text-xs"
        >
          <span>
            {token.name} · expires{" "}
            {token.expiresAt
              ? new Date(token.expiresAt).toLocaleDateString()
              : "unknown"}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void manage({ action: "revoke", id: token.id })}
          >
            Revoke
          </Button>
        </div>
      ))}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          GitHub Actions example
        </summary>
        <p className="my-2 text-xs text-slate-500">
          Place this under jobs in your existing workflow. Checks must run on
          the configured branch before this job.
        </p>
        <pre className="max-h-96 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-100">
          {workflow}
        </pre>
      </details>
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          Use another CI provider
        </summary>
        <p className="mt-2 text-sm text-slate-600">
          After checks pass, POST JSON containing <code>branch</code> and the
          full tested <code>expectedCommit</code> to the deployment URL. Include
          your bearer token and a unique <code>Idempotency-Key</code> for the
          run. Poll the returned job ID at <code>deployment URL/id</code> until
          it finishes. Treat every final status except <code>succeeded</code> as
          failure. Reuse the same key when retrying an uncertain submission.
        </p>
      </details>
    </div>
  );
}
