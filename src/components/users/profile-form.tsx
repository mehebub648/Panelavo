"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, LoaderCircle, Save, ShieldCheck, UserRound } from "lucide-react";
import { toast } from "sonner";
import type { CloudPanelUser } from "@/types/cloudpanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { timezoneChoices } from "@/lib/timezones";

export function ProfileForm({ user }: { user: CloudPanelUser }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"profile" | "password" | null>(null);
  const zones = useMemo(() => timezoneChoices(user.timezone), [user.timezone]);
  const [passwords, setPasswords] = useState({ current: "", next: "", confirm: "" });

  async function submitProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy("profile");
    try {
      const response = await fetch("/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "update",
          firstName: String(data.get("firstName") ?? ""),
          lastName: String(data.get("lastName") ?? ""),
          email: String(data.get("email") ?? ""),
          timezone: String(data.get("timezone") ?? "UTC"),
        }),
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error?.message || "Profile could not be updated.");
      toast.success("Profile updated");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Profile could not be updated.");
    } finally {
      setBusy(null);
    }
  }

  async function submitPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (passwords.next !== passwords.confirm) {
      toast.error("The new passwords do not match.");
      return;
    }
    setBusy("password");
    try {
      const response = await fetch("/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "change-password",
          currentPassword: passwords.current,
          newPassword: passwords.next,
        }),
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error?.message || "Password could not be changed.");
      toast.success("Password changed");
      setPasswords({ current: "", next: "", confirm: "" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Password could not be changed.");
    } finally {
      setBusy(null);
    }
  }

  const card =
    "overflow-hidden rounded-2xl border border-white/40 bg-white/60 backdrop-blur-md shadow-card";

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5">
      <div className="flex items-center gap-4">
        <span className="grid h-14 w-14 place-items-center rounded-2xl bg-panel-100 text-xl font-bold text-panel-700">
          {(user.displayName || user.username).slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0">
          <h2 className="truncate text-2xl font-bold tracking-tight text-ink">
            {user.displayName || user.username}
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm text-slate-500">
            <span>{user.username}</span>
            <span className="text-slate-300">·</span>
            <span className="inline-flex items-center gap-1 capitalize">
              <ShieldCheck className="h-3.5 w-3.5 text-panel-600" />
              {user.panelRole?.replace("-", " ") || "user"}
            </span>
          </p>
        </div>
      </div>

      <form onSubmit={submitProfile} className={card}>
        <div className="border-b border-slate-200/50 bg-slate-50/40 px-5 py-4 sm:px-6">
          <h3 className="flex items-center gap-2 font-bold">
            <UserRound className="h-4 w-4 text-panel-600" /> Profile details
          </h3>
          <p className="mt-0.5 text-sm text-slate-500">Your name, contact email, and timezone.</p>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-2 sm:p-6">
          <div>
            <Label htmlFor="firstName">First name</Label>
            <Input id="firstName" name="firstName" defaultValue={user.firstName ?? ""} className="mt-1.5" required />
          </div>
          <div>
            <Label htmlFor="lastName">Last name</Label>
            <Input id="lastName" name="lastName" defaultValue={user.lastName ?? ""} className="mt-1.5" required />
          </div>
          <div>
            <Label htmlFor="email">Email address</Label>
            <Input id="email" name="email" type="email" defaultValue={user.email ?? ""} className="mt-1.5" required />
          </div>
          <div>
            <Label htmlFor="timezone">Timezone</Label>
            <Select id="timezone" name="timezone" defaultValue={user.timezone ?? "UTC"} className="mt-1.5">
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="flex justify-end border-t border-slate-200/50 bg-slate-50/40 px-5 py-4 sm:px-6">
          <Button disabled={busy !== null}>
            {busy === "profile" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save profile
          </Button>
        </div>
      </form>

      <form onSubmit={submitPassword} className={card}>
        <div className="border-b border-slate-200/50 bg-slate-50/40 px-5 py-4 sm:px-6">
          <h3 className="flex items-center gap-2 font-bold">
            <KeyRound className="h-4 w-4 text-panel-600" /> Change password
          </h3>
          <p className="mt-0.5 text-sm text-slate-500">
            Your current password is required to confirm the change.
          </p>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-3 sm:p-6">
          <div>
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={passwords.current}
              onChange={(event) => setPasswords({ ...passwords, current: event.target.value })}
              className="mt-1.5"
              required
            />
          </div>
          <div>
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              placeholder="Min 12 characters"
              value={passwords.next}
              onChange={(event) => setPasswords({ ...passwords, next: event.target.value })}
              className="mt-1.5"
              required
            />
          </div>
          <div>
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={passwords.confirm}
              onChange={(event) => setPasswords({ ...passwords, confirm: event.target.value })}
              className="mt-1.5"
              required
            />
          </div>
        </div>
        <div className="flex justify-end border-t border-slate-200/50 bg-slate-50/40 px-5 py-4 sm:px-6">
          <Button disabled={busy !== null}>
            {busy === "password" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Change password
          </Button>
        </div>
      </form>
    </div>
  );
}
