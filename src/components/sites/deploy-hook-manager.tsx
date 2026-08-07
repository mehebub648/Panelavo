"use client";

import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  LoaderCircle,
  Plus,
  Rocket,
  Save,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  deployHookCommands,
  type DeployHookOperation,
} from "@/lib/deploy-hooks";

export function DeployHookManager({ domain }: { domain: string }) {
  const [hooks, setHooks] = useState<DeployHookOperation[]>([]);
  const [command, setCommand] =
    useState<(typeof deployHookCommands)[number]>("node-install");
  const [argument, setArgument] = useState("");
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    fetch(`/api/sites/${encodeURIComponent(domain)}/deploy-hooks`)
      .then((response) => response.json())
      .then((result) => {
        if (result.success) setHooks(result.data);
      })
      .finally(() => setBusy(false));
  }, [domain]);
  const needsScript = command === "node-run" || command === "npm-run";
  const needsName = command === "pm2-restart-one";
  function add() {
    if ((needsScript || needsName) && !argument.trim()) return;
    setHooks([
      ...hooks,
      {
        command,
        ...(needsScript ? { script: argument.trim() } : {}),
        ...(needsName ? { name: argument.trim() } : {}),
      },
    ]);
    setArgument("");
  }
  function move(index: number, delta: number) {
    const next = [...hooks];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setHooks(next);
  }
  async function save() {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/sites/${encodeURIComponent(domain)}/deploy-hooks`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hooks }),
        },
      );
      const result = await response.json();
      if (!result.success)
        throw new Error(
          result.error?.message || "Deployment plan could not be saved.",
        );
      setHooks(result.data);
      toast.success("Post-pull deployment plan saved");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Deployment plan could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rounded-2xl border bg-white shadow-card">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
        <div>
          <h3 className="flex items-center gap-2 font-bold">
            <Rocket className="h-4 w-4 text-panel-600" /> After-pull deployment
          </h3>
          <p className="text-xs text-slate-500">
            Pull runs these vetted Operations in order under one site lock. No
            shell script is accepted.
          </p>
        </div>
        <Button size="sm" disabled={busy} onClick={save}>
          {busy ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}{" "}
          Save
        </Button>
      </div>
      <div className="space-y-3 p-5">
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Select
            value={command}
            onChange={(event) =>
              setCommand(event.target.value as typeof command)
            }
          >
            {deployHookCommands.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </Select>
          <Input
            value={argument}
            disabled={!needsScript && !needsName}
            onChange={(event) => setArgument(event.target.value)}
            placeholder={
              needsScript
                ? "Detected package script"
                : needsName
                  ? "PM2 process name"
                  : "No argument required"
            }
          />
          <Button
            variant="outline"
            disabled={
              hooks.length >= 10 ||
              ((needsScript || needsName) && !argument.trim())
            }
            onClick={add}
          >
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>
        {hooks.length === 0 ? (
          <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500">
            Pull only. Add operations to turn Pull into a deployment.
          </p>
        ) : (
          <div className="divide-y rounded-xl border">
            {hooks.map((hook, index) => (
              <div
                key={`${index}:${hook.command}`}
                className="flex items-center gap-2 px-3 py-2"
              >
                <span className="w-6 text-xs text-slate-400">{index + 1}</span>
                <code className="min-w-0 flex-1 truncate text-sm">
                  {hook.command}
                  {hook.script
                    ? ` ${hook.script}`
                    : hook.name
                      ? ` ${hook.name}`
                      : ""}
                </code>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  aria-label="Move up"
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={index === hooks.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label="Move down"
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() =>
                    setHooks(hooks.filter((_, item) => item !== index))
                  }
                  aria-label="Remove"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
