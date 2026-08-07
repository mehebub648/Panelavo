"use client";

import { useState } from "react";
import { LoaderCircle, Save, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SecuritySettings } from "@/server/settings/store";

export function SecurityPolicyManager({
  initialSettings,
}: {
  initialSettings: SecuritySettings;
}) {
  const [value, setValue] = useState(initialSettings);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const response = await fetch("/api/security/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      });
      const result = await response.json();
      if (!result.success)
        throw new Error(
          result.error?.message || "Security policy could not be saved.",
        );
      setValue(result.data);
      toast.success("Security policy saved");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Security policy could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
      <div className="border-b border-slate-100 bg-slate-50/60 px-5 py-4 sm:px-6">
        <h3 className="flex items-center gap-2 font-bold">
          <ShieldCheck className="h-4 w-4 text-panel-600" /> Account security
          policy
        </h3>
        <p className="text-sm text-slate-500">
          Applies to new sessions and future password changes.
        </p>
      </div>
      <div className="grid gap-4 p-5 sm:grid-cols-2 sm:p-6">
        <div>
          <Label htmlFor="session-lifetime">Session lifetime (minutes)</Label>
          <Input
            id="session-lifetime"
            type="number"
            min={15}
            max={10080}
            value={value.sessionLifetimeMinutes}
            onChange={(event) =>
              setValue({
                ...value,
                sessionLifetimeMinutes: Number(event.target.value),
              })
            }
            className="mt-1.5"
          />
        </div>
        <div>
          <Label htmlFor="password-length">Minimum password length</Label>
          <Input
            id="password-length"
            type="number"
            min={12}
            max={128}
            value={value.passwordMinLength}
            onChange={(event) =>
              setValue({
                ...value,
                passwordMinLength: Number(event.target.value),
              })
            }
            className="mt-1.5"
          />
        </div>
        <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
          {(
            [
              ["requireUppercase", "Require uppercase letter"],
              ["requireLowercase", "Require lowercase letter"],
              ["requireNumber", "Require number"],
              ["requireSymbol", "Require symbol"],
            ] as const
          ).map(([key, label]) => (
            <label
              key={key}
              className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm"
            >
              <input
                type="checkbox"
                checked={value[key]}
                onChange={(event) =>
                  setValue({ ...value, [key]: event.target.checked })
                }
              />{" "}
              {label}
            </label>
          ))}
        </div>
      </div>
      <div className="flex justify-end border-t border-slate-100 bg-slate-50/60 px-5 py-4 sm:px-6">
        <Button disabled={busy} onClick={save}>
          {busy ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}{" "}
          Save policy
        </Button>
      </div>
    </section>
  );
}
