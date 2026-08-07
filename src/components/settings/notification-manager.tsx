"use client";

import { useState } from "react";
import { BellRing, LoaderCircle, Send, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type PublicNotificationSettings = {
  smtp: { enabled: boolean; host: string; port: number; secure: boolean; username: string; password: string; hasPassword: boolean; from: string; to: string };
  webhook: { enabled: boolean; url: string };
} | null;

export function NotificationManager({ initialSettings }: { initialSettings: PublicNotificationSettings }) {
  const [form, setForm] = useState({
    smtp: initialSettings?.smtp ?? { enabled: false, host: "", port: 587, secure: false, username: "", password: "", hasPassword: false, from: "", to: "" },
    webhook: initialSettings?.webhook ?? { enabled: false, url: "" },
  });
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [configured, setConfigured] = useState(Boolean(initialSettings));
  async function request(method: "PUT" | "POST", body?: unknown) {
    const response = await fetch("/api/notifications/settings", { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json();
    if (!result.success) throw new Error(result.error?.message || "Notification operation failed.");
    return result.data;
  }
  async function save() {
    setBusy("save");
    try {
      const saved = await request("PUT", { smtp: { ...form.smtp, hasPassword: undefined }, webhook: form.webhook });
      setForm((current) => ({ ...current, smtp: { ...current.smtp, password: "", hasPassword: saved.smtp.hasPassword } }));
      setConfigured(true);
      toast.success("Notification channels saved");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not save channels."); }
    finally { setBusy(null); }
  }
  async function test() {
    setBusy("test");
    try { await request("POST"); toast.success("Test notification delivered"); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Test delivery failed."); }
    finally { setBusy(null); }
  }
  const smtp = (key: string, value: unknown) => setForm((current) => ({ ...current, smtp: { ...current.smtp, [key]: value } }));
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
      <div className="flex items-center gap-3 border-b border-slate-100 bg-slate-50/60 px-5 py-4 sm:px-6"><span className="grid h-10 w-10 place-items-center rounded-xl bg-panel-50 text-panel-600"><BellRing className="h-5 w-5" /></span><div><h3 className="font-bold">Notification channels</h3><p className="text-sm text-slate-500">Panel-wide email and generic webhook delivery for alerts and recoveries.</p></div></div>
      <div className="space-y-5 p-5 sm:p-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={form.smtp.enabled} onChange={(event) => smtp("enabled", event.target.checked)} /> Enable SMTP email</label>
          <div><Label>SMTP host</Label><Input value={form.smtp.host} onChange={(event) => smtp("host", event.target.value)} /></div>
          <div><Label>Port</Label><Input type="number" min={1} max={65535} value={form.smtp.port} onChange={(event) => smtp("port", Number(event.target.value))} /></div>
          <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={form.smtp.secure} onChange={(event) => smtp("secure", event.target.checked)} /> Implicit TLS</label>
          <div><Label>Username</Label><Input value={form.smtp.username} onChange={(event) => smtp("username", event.target.value)} /></div>
          <div><Label>Password</Label><Input type="password" value={form.smtp.password} placeholder={form.smtp.hasPassword ? "Leave blank to keep existing" : ""} onChange={(event) => smtp("password", event.target.value)} /></div>
          <div><Label>From address</Label><Input type="email" value={form.smtp.from} onChange={(event) => smtp("from", event.target.value)} /></div>
          <div><Label>Recipient</Label><Input type="email" value={form.smtp.to} onChange={(event) => smtp("to", event.target.value)} /></div>
        </div>
        <div className="grid gap-4 border-t border-slate-100 pt-5 sm:grid-cols-[auto_1fr] sm:items-end">
          <label className="flex h-10 items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={form.webhook.enabled} onChange={(event) => setForm((current) => ({ ...current, webhook: { ...current.webhook, enabled: event.target.checked } }))} /> Enable webhook</label>
          <div><Label>HTTPS webhook URL</Label><Input type="url" value={form.webhook.url} onChange={(event) => setForm((current) => ({ ...current, webhook: { ...current.webhook, url: event.target.value } }))} placeholder="Slack, Discord, Telegram proxy, or generic receiver" /></div>
        </div>
        <div className="flex flex-wrap gap-2"><Button disabled={Boolean(busy)} onClick={() => void save()}>{busy === "save" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Save channels</Button><Button variant="outline" disabled={Boolean(busy) || !configured} onClick={() => void test()}>{busy === "test" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}Send test</Button></div>
      </div>
    </section>
  );
}
