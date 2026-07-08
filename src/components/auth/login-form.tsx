"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ApiResponse = {
  success: boolean;
  data?: { status: string };
  error?: { message: string };
};

export function LoginForm({
  initialTwoFactor = false,
}: {
  initialTwoFactor?: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState<"login" | "two-factor">(
    initialTwoFactor ? "two-factor" : "login",
  );
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const body =
      step === "login"
        ? { username: form.get("username"), password: form.get("password") }
        : { code: form.get("code") };
    try {
      const response = await fetch(
        step === "login" ? "/api/auth/login" : "/api/auth/two-factor",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const result = (await response.json()) as ApiResponse;
      if (!result.success)
        throw new Error(result.error?.message ?? "Sign in failed.");
      if (result.data?.status === "two-factor-required") {
        setStep("two-factor");
        return;
      }
      router.replace("/sites");
      router.refresh();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "CloudPanel could not be reached.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-5"
      aria-describedby={error ? "login-error" : undefined}
    >
      {step === "login" ? (
        <>
          <div>
            <Label htmlFor="username">User name</Label>
            <Input
              id="username"
              name="username"
              autoComplete="username"
              placeholder="Enter your CloudPanel user name"
              required
              autoFocus
            />
          </div>
          <div>
            <div className="relative">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                placeholder="Enter your password"
                className="pr-11"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                className="absolute bottom-0 right-0 grid h-11 w-11 place-items-center text-slate-400 hover:text-slate-700"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-3 rounded-xl bg-panel-50 p-4 text-sm text-panel-700">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <span>
              Open your authenticator app and enter the current 6-digit code.
            </span>
          </div>
          <div>
            <Label htmlFor="code">Verification code</Label>
            <Input
              id="code"
              name="code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              autoComplete="one-time-code"
              placeholder="000000"
              className="text-center text-lg tracking-[.45em]"
              required
              autoFocus
            />
          </div>
        </>
      )}
      {error && (
        <div
          id="login-error"
          role="alert"
          className="flex gap-2 rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700"
        >
          <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      )}
      <Button type="submit" size="lg" className="w-full" disabled={busy}>
        {busy ? (
          <>
            <LoaderCircle className="h-4 w-4 animate-spin" />
            {step === "login" ? "Signing in…" : "Verifying…"}
          </>
        ) : (
          <>
            {step === "login" ? "Sign in" : "Verify and continue"}
            <ArrowRight className="h-4 w-4" />
          </>
        )}
      </Button>
      {step === "two-factor" && (
        <button
          type="button"
          className="w-full text-sm font-medium text-slate-500 hover:text-slate-800"
          onClick={() => {
            setStep("login");
            setError("");
          }}
        >
          Use a different account
        </button>
      )}
    </form>
  );
}
