"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, ShieldCheck, ShieldOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Enrollment = { secret: string; qrCode: string };

export function MfaManager({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);

  async function submit(action: "start" | "enable" | "disable") {
    setBusy(true);
    try {
      const response = await fetch("/api/profile/mfa", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, currentPassword: password, code }),
      });
      const result = await response.json();
      if (!result.success)
        throw new Error(
          result.error?.message ||
            "Two-factor authentication could not be changed.",
        );
      if (action === "start") {
        setEnrollment(result.data);
        setPassword("");
      } else {
        setEnrollment(null);
        setCode("");
        toast.success(
          action === "enable"
            ? "Two-factor authentication enabled"
            : "Two-factor authentication disabled",
        );
        router.refresh();
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Two-factor authentication could not be changed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-white/40 bg-white/60 shadow-card backdrop-blur-md">
      <div className="border-b border-slate-200/50 bg-slate-50/40 px-5 py-4 sm:px-6">
        <h3 className="flex items-center gap-2 font-bold">
          <ShieldCheck className="h-4 w-4 text-panel-600" /> Two-factor
          authentication
        </h3>
        <p className="mt-0.5 text-sm text-slate-500">
          {enabled
            ? "Enabled. A current authenticator code is required to disable it."
            : "Protect sign-in with a time-based authenticator app."}
        </p>
      </div>
      <div className="space-y-4 p-5 sm:p-6">
        {!enabled && !enrollment && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Label htmlFor="mfa-password">Current password</Label>
              <Input
                id="mfa-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="mt-1.5"
              />
            </div>
            <Button
              type="button"
              disabled={busy || !password}
              onClick={() => submit("start")}
            >
              {busy && <LoaderCircle className="h-4 w-4 animate-spin" />} Set up
              authenticator
            </Button>
          </div>
        )}
        {!enabled && enrollment && (
          <div className="grid gap-5 sm:grid-cols-[240px_1fr]">
            {/* The QR payload is generated server-side from the short-lived secret. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={enrollment.qrCode}
              alt="Authenticator setup QR code"
              width={240}
              height={240}
              className="rounded-xl bg-white"
            />
            <div className="space-y-4">
              <div>
                <Label>Manual setup key</Label>
                <code className="mt-1.5 block break-all rounded-lg bg-slate-100 p-3 text-sm">
                  {enrollment.secret}
                </code>
              </div>
              <div>
                <Label htmlFor="mfa-enable-code">Six-digit code</Label>
                <Input
                  id="mfa-enable-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(event) =>
                    setCode(event.target.value.replace(/\D/g, ""))
                  }
                  className="mt-1.5"
                />
              </div>
              <Button
                type="button"
                disabled={busy || code.length !== 6}
                onClick={() => submit("enable")}
              >
                {busy && <LoaderCircle className="h-4 w-4 animate-spin" />}{" "}
                Verify and enable
              </Button>
            </div>
          </div>
        )}
        {enabled && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Label htmlFor="mfa-disable-code">
                Current authenticator code
              </Label>
              <Input
                id="mfa-disable-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(event) =>
                  setCode(event.target.value.replace(/\D/g, ""))
                }
                className="mt-1.5"
              />
            </div>
            <Button
              type="button"
              variant="danger"
              disabled={busy || code.length !== 6}
              onClick={() => submit("disable")}
            >
              {busy ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldOff className="h-4 w-4" />
              )}{" "}
              Disable two-factor
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
