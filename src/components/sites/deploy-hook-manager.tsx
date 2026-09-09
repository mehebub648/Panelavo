"use client";

import React, { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  deployHookCommands,
  type DeployHookOperation,
} from "@/lib/deploy-hooks";
import type { OperationsData } from "@/types/operations";
import { AutomaticDeployment } from "./automatic-deployment";

type Settings = {
  hooks: DeployHookOperation[];
  branch: string;
  healthPath: string;
  automationEnabled: boolean;
  runtime?: OperationsData;
};
const labels: Record<string, string> = {
  "node-install": "Install JavaScript dependencies",
  "node-run": "Run package script",
  "npm-install": "Install npm dependencies",
  "npm-ci": "Install locked npm dependencies",
  "npm-run": "Run npm script",
  "composer-install": "Install PHP dependencies",
  "composer-install-production": "Install production PHP dependencies",
  "composer-validate": "Validate Composer configuration",
  "python-create-venv": "Create Python environment",
  "python-install": "Install Python dependencies",
  "pip-install": "Install pip dependencies",
  "artisan-migrate": "Apply Laravel database migrations",
  "django-migrate": "Apply Django database migrations",
  "compose-deploy": "Build and start containers",
  "compose-up": "Apply container configuration",
  "compose-restart": "Restart containers",
  "compose-validate": "Validate container configuration",
  "compose-pull": "Download container images",
  "compose-ps": "Check container status",
  "pm2-start": "Start or reload application",
  "pm2-restart": "Restart application processes",
  "pm2-restart-one": "Restart selected process",
  "pm2-save": "Save process configuration",
  "upstream-check": "Check application response",
};
function label(command: string, runtime?: OperationsData) {
  return (
    labels[command] ||
    runtime?.groups
      ?.flatMap((group) => group.actions)
      .find((action) => action.id === command)?.label ||
    command.replaceAll("-", " ")
  );
}

export function DeployHookManager({
  domain,
  apiBase = "",
}: {
  domain: string;
  apiBase?: string;
}) {
  const base = `${apiBase}/api/sites/${encodeURIComponent(domain)}`;
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState<DeployHookOperation["command"]>();
  const [argument, setArgument] = useState("");
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const result = await fetch(`${base}/deployment-settings`).then(
        (response) => response.json(),
      );
      if (!result.success)
        throw new Error(
          result.error?.message || "Deployment settings could not be loaded.",
        );
      setSettings(result.data);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Deployment settings could not be loaded.",
      );
      setSettings(undefined);
    } finally {
      setBusy(false);
    }
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!settings)
    return (
      <div
        role={error ? "alert" : "status"}
        className="rounded-lg bg-slate-50 p-4 text-sm"
      >
        {error || "Loading deployment settings…"}
        {error && (
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        )}
      </div>
    );
  const runtime = settings.runtime;
  const detected = new Set(
    runtime?.groups?.flatMap((group) =>
      group.actions.map((action) => action.id),
    ) ?? [],
  );
  if (runtime?.pm2?.length && runtime.tools?.pm2?.available)
    detected.add("pm2-restart-one");
  const choices = deployHookCommands.filter((item) => detected.has(item));
  const selected = command && choices.includes(command) ? command : choices[0];
  const needsScript = selected === "node-run" || selected === "npm-run";
  const needsName = selected === "pm2-restart-one";
  const argumentsAvailable = needsScript
    ? (runtime?.scripts?.map((item) => item.name) ?? [])
    : needsName
      ? (runtime?.pm2?.map((item) => item.name) ?? [])
      : [];
  const selectedArgument = argumentsAvailable.includes(argument)
    ? argument
    : (argumentsAvailable[0] ?? "");
  function change(patch: Partial<Settings>) {
    setSettings((current) => (current ? { ...current, ...patch } : current));
  }
  function move(index: number, delta: number) {
    if (!settings) return;
    const hooks = [...settings.hooks];
    [hooks[index], hooks[index + delta]] = [hooks[index + delta], hooks[index]];
    change({ hooks });
  }
  async function save() {
    if (!settings) return;
    setBusy(true);
    setError("");
    try {
      const { runtime: ignoredRuntime, ...input } = settings;
      void ignoredRuntime;
      const result = await fetch(`${base}/deployment-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }).then((response) => response.json());
      if (!result.success)
        throw new Error(
          result.error?.message || "Deployment settings could not be saved.",
        );
      change(result.data);
      toast.success("Deployment settings saved");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Deployment settings could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          Deployment branch
          <Input
            value={settings.branch}
            onChange={(event) => change({ branch: event.target.value })}
            placeholder="Current branch"
          />
        </label>
        <label className="space-y-1 text-sm">
          Health check path
          <Input
            value={settings.healthPath}
            onChange={(event) => change({ healthPath: event.target.value })}
            placeholder="/"
          />
        </label>
      </div>
      <p className="text-xs text-slate-500">
        Deployment succeeds when the application responds with HTTP 200–399 at
        this path.
      </p>
      <details open={settings.hooks.length > 0}>
        <summary className="cursor-pointer text-sm font-semibold">
          Custom deployment steps{" "}
          {settings.hooks.length ? `(${settings.hooks.length})` : "(optional)"}
        </summary>
        <p className="my-3 text-sm text-slate-500">
          {settings.hooks.length
            ? "These saved steps replace the suggested plan. The application response is checked afterwards."
            : `The detected plan will be used${runtime?.plan ? `: ${runtime.plan.label}` : ". Plain websites only need a response check"}.`}
        </p>
        {!settings.hooks.length && runtime?.plan && (
          <ol className="mb-3 list-inside list-decimal text-sm text-slate-600">
            {runtime.plan.steps.map((step) => (
              <li key={step.command}>{step.label}</li>
            ))}
          </ol>
        )}
        <div className="space-y-2">
          {settings.hooks.map((hook, index) => (
            <div
              key={index}
              className="flex flex-wrap items-center gap-2 rounded-lg border p-3"
            >
              <span className="min-w-0 flex-1 text-sm">
                {index + 1}. {label(hook.command, runtime)}{" "}
                {hook.script || hook.name}
                {hook.command.endsWith("-migrate") && (
                  <strong className="block text-xs text-amber-700">
                    Changes the database; automatic reversal is unavailable.
                  </strong>
                )}
              </span>
              <Button
                size="icon"
                variant="ghost"
                disabled={busy || index === 0}
                aria-label={`Move step ${index + 1} up`}
                onClick={() => move(index, -1)}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                disabled={busy || index === settings.hooks.length - 1}
                aria-label={`Move step ${index + 1} down`}
                onClick={() => move(index, 1)}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                disabled={busy}
                aria-label={`Remove step ${index + 1}`}
                onClick={() =>
                  change({
                    hooks: settings.hooks.filter((_, i) => index !== i),
                  })
                }
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
        {choices.length > 0 && (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Select
              aria-label="Deployment step"
              className="min-w-0 flex-1"
              value={selected}
              onChange={(event) => {
                setCommand(
                  event.target.value as DeployHookOperation["command"],
                );
                setArgument("");
              }}
            >
              {choices.map((item) => (
                <option key={item} value={item}>
                  {label(item, runtime)}
                </option>
              ))}
            </Select>
            {(needsScript || needsName) && (
              <Select
                aria-label={
                  needsScript ? "Package script" : "Application process"
                }
                value={selectedArgument}
                onChange={(event) => setArgument(event.target.value)}
              >
                {argumentsAvailable.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </Select>
            )}
            <Button
              variant="outline"
              disabled={
                busy ||
                settings.hooks.length >= 10 ||
                ((needsScript || needsName) && !selectedArgument)
              }
              onClick={() =>
                selected &&
                change({
                  hooks: [
                    ...settings.hooks,
                    {
                      command: selected,
                      ...(needsScript ? { script: selectedArgument } : {}),
                      ...(needsName ? { name: selectedArgument } : {}),
                    },
                  ],
                })
              }
            >
              <Plus className="h-4 w-4" />
              Add step
            </Button>
          </div>
        )}
      </details>
      <details>
        <summary className="cursor-pointer text-sm font-semibold">
          Automatic deployment
        </summary>
        <div className="mt-3 space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.automationEnabled}
              onChange={(event) =>
                change({ automationEnabled: event.target.checked })
              }
            />
            Allow deployment from CI
          </label>
          <p className="text-xs text-slate-500">
            Save this setting before using the API. Only the configured branch
            and its tested commit are accepted.
          </p>
          <AutomaticDeployment
            domain={domain}
            apiBase={apiBase}
            branch={settings.branch}
          />
        </div>
      </details>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <Button disabled={busy} onClick={() => void save()}>
        {busy ? "Validating…" : "Save deployment settings"}
      </Button>
    </div>
  );
}
