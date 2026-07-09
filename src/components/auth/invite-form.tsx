"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Eye, EyeOff, LoaderCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function InviteForm({ token, username }: { token: string; username: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const result = await response.json();
      if (!result.success)
        throw new Error(result.error?.message || "The account could not be created.");
      setDone(true);
      setTimeout(() => router.replace("/login"), 2500);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The account could not be created.");
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-center">
        <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-600" />
        <p className="mt-3 font-bold text-emerald-800">Your account is ready</p>
        <p className="mt-1 text-sm text-emerald-700">
          Sign in as <b>{username}</b> with your new password. Redirecting…
        </p>
      </div>
    );

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <Label htmlFor="invite-password">Choose a password</Label>
        <div className="relative mt-1.5">
          <Input
            id="invite-password"
            type={show ? "text" : "password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={12}
            autoComplete="new-password"
            placeholder="At least 12 characters"
            className="pr-10"
            autoFocus
            required
          />
          <button
            type="button"
            onClick={() => setShow((value) => !value)}
            className="absolute right-0 top-0 grid h-11 w-10 place-items-center text-slate-400"
            aria-label={show ? "Hide password" : "Show password"}
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>
      <div>
        <Label htmlFor="invite-confirm">Confirm password</Label>
        <Input
          id="invite-confirm"
          type={show ? "text" : "password"}
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          minLength={12}
          autoComplete="new-password"
          className="mt-1.5"
          required
        />
      </div>
      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      )}
      <Button className="w-full" disabled={busy}>
        {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
        Create my account
      </Button>
    </form>
  );
}
