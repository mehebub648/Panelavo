"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  Ban,
  Bot,
  Cloud,
  Copy,
  Database,
  EyeOff,
  ExternalLink,
  KeyRound,
  LockKeyhole,
  LoaderCircle,
  Plus,
  Save,
  Shield,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FileManager, type FileManagerData } from "@/components/sites/file-manager";
import { CodeEditor, preloadCodeEditor } from "@/components/ui/code-editor";
import { certAlternativeNames } from "@/lib/domains";

type DatabaseItem = { id: string; name: string; users?: string[] };
type CertificateItem = { id: string; type?: string; domains?: string[]; expiresAt?: string; default?: boolean };
type FtpItem = { username: string; home?: string };
type CronItem = { id: string; expression: string; command: string };
type Data = Record<string, unknown> & {
  content?: string;
  items?: unknown[];
  blockedIps?: string[];
  blockedBots?: string[];
  basicAuth?: { active?: boolean; username?: string };
  cloudflareOnly?: boolean;
  primary?: string;
  ssh?: string[];
  ftp?: FtpItem[];
  path?: string;
  sitePath?: string;
  keyPair?: { exists?: boolean; publicKey?: string; privateKeyMasked?: string; fingerprint?: string };
};

export function SiteSectionManager({
  domain,
  section,
  initialData,
  databaseManagerUrl,
}: {
  domain: string;
  section: string;
  initialData: Data;
  // Dedicated phpMyAdmin site (database.<ip>.<base>) with a trusted
  // certificate; replaces CloudPanel's self-signed, firewalled :8443/pma.
  databaseManagerUrl?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const data = initialData;
  const [openForm, setOpenForm] = useState<string | null>(null);
  const [logViewer, setLogViewer] = useState<null | { name: string; content: string; truncated?: boolean }>(null);
  const [editorContent, setEditorContent] = useState(String(initialData.content ?? ""));
  const [savedEditorContent, setSavedEditorContent] = useState(String(initialData.content ?? ""));

  const [confirmAction, setConfirmAction] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);

  async function act(input: Record<string, unknown>, skipConfirm = false) {
    if (busy) return false;
    if (["delete", "clear"].some((value) => String(input.action).includes(value)) && !skipConfirm) {
      const clearing = input.action === "clear";
      setConfirmAction({
        title: clearing ? "Clear log" : "Remove item",
        message: clearing
          ? "Permanently remove the current contents of this log file?"
          : "Remove this item? This action cannot be undone.",
        onConfirm: () => {
          setConfirmAction(null);
          void act(input, true);
        }
      });
      return false;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/sites/${encodeURIComponent(domain)}/sections/${section}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      const result = await response.json();
      if (!result.success)
        throw new Error(
          result.error?.message || "CloudPanel could not apply the change.",
        );
      toast.success("Changes applied");
      router.refresh();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Operation failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  // Opens phpMyAdmin already signed in as the database's own user. The tab
  // must be opened synchronously inside the click (popup blockers), then
  // navigated once the server returns the one-time signon URL.
  async function openDatabase(name: string) {
    const tab = window.open("", "_blank");
    try {
      const response = await fetch(
        `/api/sites/${encodeURIComponent(domain)}/sections/${section}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "manage-login", name }),
        },
      );
      const result = await response.json();
      const url = result.success ? String(result.data?.url ?? "") : "";
      if (!url)
        throw new Error(
          result.error?.message || "The phpMyAdmin sign-in could not be prepared.",
        );
      if (tab) tab.location.href = url;
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch (reason) {
      tab?.close();
      toast.error(
        reason instanceof Error ? reason.message : "The phpMyAdmin sign-in failed.",
      );
    }
  }

  useEffect(() => {
    void preloadCodeEditor().catch(() => undefined);
    function shortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        const target = event.target as HTMLElement;
        const form = target.closest("form");
        if (form) {
          event.preventDefault();
          form.requestSubmit();
        }
      }
    }
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, []);
  function submit(action: string, event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    return act({ action, ...values });
  }
  async function readLog(name: string) {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(domain)}/sections/logs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "read", name }) });
      const result = await response.json();
      if (!result.success) throw new Error(result.error?.message || "Could not read this log.");
      setLogViewer(result.data);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not read this log."); }
    finally { setBusy(false); }
  }
  const card =
    "overflow-hidden rounded-2xl border border-white/40 bg-white/60 backdrop-blur-md shadow-card transition-all hover:shadow-card-hover animate-fade-in p-5 sm:p-6";
  const feedback = error ? (
    <p
      role="alert"
      className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
    >
      {error}
    </p>
  ) : null;

  function renderContent() {
    if (section === "vhost")
      return (
        <div className={card}>
          <form onSubmit={async (event) => { event.preventDefault(); const saved = await act({ action: "save", content: editorContent }); if (saved) setSavedEditorContent(editorContent); }} className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-bold">NGINX configuration</h3>
                <p className="text-sm text-slate-500">
                  Invalid configurations are automatically rolled back.
                </p>
              </div>
              <kbd className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-500 shadow-sm flex items-center gap-1">
                <span className="opacity-70">Ctrl/⌘</span> <span>Enter</span>
              </kbd>
            </div>
            <input type="hidden" name="content" value={editorContent} />
            <CodeEditor value={editorContent} onChange={setEditorContent} language="nginx" height="62vh" ariaLabel="NGINX configuration" />
            {feedback}
            <div className="flex items-center justify-between gap-3">
              <p className={`flex items-center gap-2 text-sm font-medium ${editorContent === savedEditorContent ? "text-emerald-600" : "text-amber-600"}`}>
                {busy ? <><LoaderCircle className="h-4 w-4 animate-spin" /> Saving…</> : editorContent === savedEditorContent ? <><CheckCircle2 className="h-4 w-4" /> Saved</> : <><span className="h-2 w-2 rounded-full bg-amber-500" /> Unsaved changes</>}
              </p>
              <Button disabled={busy || editorContent === savedEditorContent}>
                {busy ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}{" "}
                Save and reload NGINX
              </Button>
            </div>
          </form>
        </div>
      );
  
    if (section === "databases")
      return (
        <div className="grid gap-5">
          <section className={card}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-bold">Databases</h2><p className="mt-1 text-sm text-slate-500">Manage databases and open them in phpMyAdmin — Manage signs you in as the database&apos;s own user automatically.</p></div><div className="flex gap-2">{databaseManagerUrl && <Button asChild variant="outline" size="sm"><a href={databaseManagerUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4" /> Open phpMyAdmin</a></Button>}<Button size="sm" onClick={() => setOpenForm(openForm === "database" ? null : "database")}><Plus className="h-4 w-4" /> Add database</Button></div></div>
            <div className="space-y-3">
              {((data.items as DatabaseItem[]) ?? []).map((item) => (
                <div
                  key={item.id}
                  className="group flex items-center justify-between rounded-xl border border-slate-200/60 bg-white/50 p-4 transition-all hover:bg-white hover:shadow-sm"
                >
                  <div className="flex gap-3">
                    <Database className="text-panel-600" />
                    <div>
                      <b>{item.name}</b>
                      <p className="text-xs text-slate-500">
                        {item.users?.join(", ") || "No users"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">{databaseManagerUrl && <Button variant="ghost" size="sm" onClick={() => void openDatabase(item.name)}><ExternalLink className="h-4 w-4" /> Manage</Button>}<Button variant="ghost" size="icon" className="opacity-60 transition-opacity hover:opacity-100" onClick={() => act({ action: "delete", name: item.name })}><Trash2 className="h-4 w-4 text-red-500 hover:text-red-600" /></Button></div>
                </div>
              ))}
              {!data.items?.length && (
                <p className="text-sm text-slate-400">No databases yet.</p>
              )}
            </div>
          </section>
          {openForm === "database" && <FormModal title="Create database" onClose={() => setOpenForm(null)}><form
            className="space-y-4"
            onSubmit={async (e) => { if (await submit("add", e)) setOpenForm(null); }}
          >
            <h2 className="font-bold">Add database</h2>
            <div>
              <Label>Database name</Label>
              <Input name="name" pattern="[A-Za-z][A-Za-z0-9-]{1,49}" title="Start with a letter; use only letters, numbers, and hyphens" defaultValue={`${domain.split(".")[0].replace(/[^a-z0-9]/gi, "-")}-db`} required />
            </div>
            <div>
              <Label>User name</Label>
              <Input name="username" pattern="[A-Za-z][A-Za-z0-9-]{2,31}" title="Start with a letter; use only letters, numbers, and hyphens" defaultValue={`${domain.split(".")[0].replace(/[^a-z0-9]/gi, "-")}-user`} required />
            </div>
            <div>
              <Label>Password</Label>
              <Input name="password" type="password" minLength={12} required />
            </div>
            {feedback}
            <Button disabled={busy}>
              <Plus className="h-4 w-4" /> Create database
            </Button>
          </form></FormModal>}
        </div>
      );
  
    if (section === "certificates")
      return (
        <div className="grid gap-5">
          <section className={card}>
            <div className="mb-4 flex items-center justify-between gap-3"><h2 className="font-bold">Installed certificates</h2><Button size="sm" onClick={() => setOpenForm(openForm === "certificate" ? null : "certificate")}><Shield className="h-4 w-4" /> Issue certificate</Button></div>
            <div className="space-y-3">
              {(() => {
                const items = data.items as CertificateItem[];
                // Self-signed placeholders (CloudPanel type 1) are not real SSL — never
                // present them as installed certificates.
                const validItems = Array.isArray(items) ? items.filter((item) => !["1", "self-signed"].includes(String(item.type).toLowerCase())) : [];
                return validItems.map((item) => (
                <div key={item.id} className={`group flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 transition-all hover:shadow-sm ${item.default ? "border-emerald-200/70 bg-emerald-50/40" : "border-slate-200/60 bg-white/50 hover:bg-white"}`}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <KeyRound className={`h-4 w-4 ${item.default ? "text-emerald-600" : "text-red-500"}`} />
                      <b className="truncate">{item.domains?.join(", ")}</b>
                      {item.type && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{item.type}</span>}
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      Expires {item.expiresAt || "unknown"}
                    </p>
                  </div>
                  {item.default ? (
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Active
                    </span>
                  ) : (
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-600 ring-1 ring-inset ring-red-600/20">
                        <Ban className="h-3.5 w-3.5" /> Inactive
                      </span>
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => act({ action: "set-default", id: item.id })}>
                        Activate
                      </Button>
                    </div>
                  )}
                </div>
                ));
              })()}
              {(() => {
                const items = data.items as CertificateItem[];
                // Self-signed placeholders (CloudPanel type 1) are not real SSL — never
                // present them as installed certificates.
                const validItems = Array.isArray(items) ? items.filter((item) => !["1", "self-signed"].includes(String(item.type).toLowerCase())) : [];
                return validItems.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-200 py-7 text-center text-sm text-slate-400">No certificates installed</div>
                ) : null;
              })()}
            </div>
          </section>
          {openForm === "certificate" && <FormModal title="Issue certificate" onClose={() => setOpenForm(null)}><form
            className="space-y-4"
            onSubmit={(e) => submit("lets-encrypt", e)}
          >
            <h2 className="font-bold">Let&apos;s Encrypt</h2>
            <p className="text-sm text-slate-500">
              Issue or renew a trusted certificate. The primary domain
              (<b>{domain}</b>) is always included.
            </p>
            <div>
              <Label>Alternative names</Label>
              <Input
                name="subjectAlternativeName"
                placeholder="www.example.com,api.example.com"
                defaultValue={certAlternativeNames(domain).join(",")}
              />
            </div>
            {feedback}
            <Button disabled={busy}>
              <Shield className="h-4 w-4" /> Issue certificate
            </Button>
          </form></FormModal>}
        </div>
      );
  
    if (section === "security")
      return (
        <div className="grid gap-5 md:grid-cols-2">
          {[
            {
              key: "blockedIps",
              title: "Blocked IPs",
              description: "IP addresses denied at the web server.",
              add: "add-ip",
              del: "delete-ip",
              placeholder: "203.0.113.4",
              icon: Ban,
            },
            {
              key: "blockedBots",
              title: "Blocked bots",
              description: "User agents prevented from accessing the site.",
              add: "add-bot",
              del: "delete-bot",
              placeholder: "BadBot",
              icon: Bot,
            },
          ].map((x) => (
            <section key={x.key} className={card}>
              <div className="flex items-start justify-between gap-3"><div className="flex gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-red-50 text-red-600"><x.icon className="h-5 w-5" /></span><div><h2 className="font-bold">{x.title}</h2><p className="mt-0.5 text-sm text-slate-500">{x.description}</p></div></div><Button variant="outline" size="sm" onClick={() => setOpenForm(x.key)}><Plus className="h-4 w-4" /> Add</Button></div>
              <div className="mt-5 space-y-2">
                {((data[x.key] as string[] | undefined) ?? []).map((v) => (
                  <div
                    key={v}
                    className="group flex items-center justify-between rounded-lg border border-slate-200/60 bg-slate-50/50 p-3 text-sm transition-all hover:bg-white hover:shadow-sm"
                  >
                    <code>{v}</code>
                    <button aria-label={`Remove ${v}`} className="opacity-60 transition-opacity hover:opacity-100" onClick={() => act({ action: x.del, value: v })}>
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </button>
                  </div>
                ))}
                {!((data[x.key] as string[] | undefined) ?? []).length && <div className="rounded-xl border border-dashed border-slate-200 py-7 text-center text-sm text-slate-400">No entries configured</div>}
              </div>
              {openForm === x.key && <FormModal title={`Add to ${x.title}`} onClose={() => setOpenForm(null)}><form className="space-y-4" onSubmit={(event) => { submit(x.add, event); setOpenForm(null); }}><div><Label>Value</Label><Input name="value" placeholder={x.placeholder} autoFocus required /></div><div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setOpenForm(null)}>Cancel</Button><Button disabled={busy}><Plus className="h-4 w-4" /> Add entry</Button></div></form></FormModal>}
            </section>
          ))}
          <section className={card}>
            <div className="flex items-start justify-between gap-4"><div className="flex gap-3"><span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${data.basicAuth?.active ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-500"}`}><LockKeyhole className="h-5 w-5" /></span><div><div className="flex items-center gap-2"><h2 className="font-bold">Basic authentication</h2><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${data.basicAuth?.active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{data.basicAuth?.active ? "Enabled" : "Disabled"}</span></div><p className="mt-1 text-sm text-slate-500">Require a username and password before serving the site.</p>{data.basicAuth?.active && <p className="mt-2 text-xs text-slate-400">User: {data.basicAuth.username}</p>}</div></div><Button variant="outline" size="sm" onClick={() => setOpenForm("basic-auth")}>Configure</Button></div>
            {openForm === "basic-auth" && <FormModal title="Basic authentication" onClose={() => setOpenForm(null)}><form className="space-y-4" onSubmit={(event) => { submit("basic-auth", event); setOpenForm(null); }}><label className="flex items-center gap-3 rounded-xl border border-slate-200 p-4 text-sm font-medium"><input name="active" type="checkbox" value="true" defaultChecked={data.basicAuth?.active} className="h-4 w-4" />Enable password protection</label><div><Label>User name</Label><Input name="username" defaultValue={data.basicAuth?.username} required /></div><div><Label>New password</Label><Input name="password" type="password" placeholder={data.basicAuth?.active ? "Leave blank to keep current password" : "Enter a strong password"} /></div>{feedback}<div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setOpenForm(null)}>Cancel</Button><Button disabled={busy}>Save protection</Button></div></form></FormModal>}
          </section>
          <section className={card}>
            <div className="flex items-start justify-between gap-4"><div className="flex gap-3"><span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${data.cloudflareOnly ? "bg-blue-50 text-blue-600" : "bg-slate-100 text-slate-500"}`}><Cloud className="h-5 w-5" /></span><div><div className="flex items-center gap-2"><h2 className="font-bold">Cloudflare-only traffic</h2><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${data.cloudflareOnly ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-500"}`}>{data.cloudflareOnly ? "Enabled" : "Disabled"}</span></div><p className="mt-1 text-sm text-slate-500">Reject requests that do not originate from Cloudflare&apos;s published networks.</p></div></div><button type="button" role="switch" aria-checked={Boolean(data.cloudflareOnly)} disabled={busy} onClick={() => act({ action: "cloudflare", enabled: !data.cloudflareOnly })} className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${data.cloudflareOnly ? "bg-panel-600" : "bg-slate-300"}`}><span className={`absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${data.cloudflareOnly ? "translate-x-5" : "translate-x-0"}`} /></button></div>
          </section>
          <div className="md:col-span-2">{feedback}</div>
        </div>
      );
  
    if (section === "users")
      return (
        <div className="grid gap-5 md:grid-cols-2">
          <section className={`${card} md:col-span-2`}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div><div className="flex items-center gap-2"><KeyRound className="h-5 w-5 text-panel-600" /><h2 className="font-bold">Deployment key pair</h2></div><p className="mt-1 text-sm text-slate-500">Use this public key with GitHub, GitLab, or another remote server.</p></div>
              {!data.keyPair?.exists && <Button disabled={busy} onClick={() => act({ action: "generate-keypair" })}>{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} Generate Ed25519 key</Button>}
            </div>
            {data.keyPair?.exists ? <div className="mt-5 grid gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4"><div className="mb-2 flex items-center justify-between"><Label>Public key</Label><Button type="button" size="sm" variant="outline" onClick={async () => { await navigator.clipboard.writeText(data.keyPair?.publicKey ?? ""); toast.success("Public key copied"); }}><Copy className="h-4 w-4" /> Copy</Button></div><code className="block break-all rounded-lg bg-white p-3 text-xs leading-5 text-slate-700">{data.keyPair.publicKey}</code><p className="mt-2 break-all text-xs text-slate-400">{data.keyPair.fingerprint}</p></div>
              <div className="rounded-xl border border-amber-200/70 bg-amber-50/50 p-4"><div className="mb-2 flex items-center gap-2"><EyeOff className="h-4 w-4 text-amber-600" /><Label>Private key preview</Label></div><pre className="overflow-hidden whitespace-pre-wrap rounded-lg bg-slate-900 p-3 text-xs leading-5 text-slate-400">{data.keyPair.privateKeyMasked}</pre><p className="mt-2 text-xs text-amber-700">Only the opening and closing lines are shown. The complete private key is never sent to the browser.</p></div>
            </div> : <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50/50 p-6 text-center text-sm text-slate-500">No deployment key has been generated for <b>{data.primary}</b>.</div>}
          </section>
          <section className={card}>
            <div className="flex items-center justify-between gap-3"><h2 className="font-bold">SSH users</h2><Button variant="outline" size="sm" onClick={() => setOpenForm(openForm === "ssh" ? null : "ssh")}><Plus className="h-4 w-4" /> Add user</Button></div>
            <p className="my-3 text-sm">
              Primary: <b>{data.primary}</b>
            </p>
            {(data.ssh ?? []).map((u) => (
              <div key={u} className="group flex justify-between border-t border-slate-100 py-3 transition-colors hover:bg-slate-50/50 px-2 rounded-lg -mx-2">
                {u}
                <button
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => act({ action: "delete-ssh", username: u })}
                >
                  <Trash2 className="h-4 w-4 text-red-500" />
                </button>
              </div>
            ))}
            {openForm === "ssh" && <FormModal title="Add SSH user" onClose={() => setOpenForm(null)}><form
              className="space-y-3"
              onSubmit={(e) => { submit("add-ssh", e); setOpenForm(null); }}
            >
              <Input name="username" placeholder="SSH user" required />
              <Input
                name="password"
                type="password"
                placeholder="Password"
                required
              />
              <textarea
                name="sshKeys"
                className="w-full rounded-lg border p-3 text-sm"
                placeholder="Optional public key"
              />
              <Button>
                <Plus className="h-4 w-4" /> Add SSH user
              </Button>
            </form></FormModal>}
          </section>
          <section className={card}>
            <div className="mb-3 flex items-center justify-between gap-3"><h2 className="font-bold">FTP users</h2><Button variant="outline" size="sm" onClick={() => setOpenForm(openForm === "ftp" ? null : "ftp")}><Plus className="h-4 w-4" /> Add user</Button></div>
            {(data.ftp ?? []).map((u) => (
              <div
                key={u.username}
                className="group flex justify-between border-b border-slate-100 py-3 transition-colors hover:bg-slate-50/50 px-2 rounded-lg -mx-2"
              >
                <div>
                  {u.username}
                  <p className="text-xs text-slate-400">{u.home}</p>
                </div>
                <button
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() =>
                    act({ action: "delete-ftp", username: u.username })
                  }
                >
                  <Trash2 className="h-4 w-4 text-red-500" />
                </button>
              </div>
            ))}
            {openForm === "ftp" && <FormModal title="Add FTP user" onClose={() => setOpenForm(null)}><form
              className="space-y-3"
              onSubmit={(e) => { submit("add-ftp", e); setOpenForm(null); }}
            >
              <Input name="username" placeholder="FTP user" required />
              <Input
                name="password"
                type="password"
                placeholder="Password"
                required
              />
              <Input name="homeDirectory" placeholder="Home directory" defaultValue={`/home/${data.primary ?? ""}`} />
              <Button>
                <Plus className="h-4 w-4" /> Add FTP user
              </Button>
            </form></FormModal>}
            {feedback}
          </section>
        </div>
      );
  
    if (section === "file-manager")
      return <FileManager domain={domain} initialData={data as FileManagerData} />;
  
    if (section === "cron-jobs")
      return (
        <div className="grid gap-5">
          <section className={card}>
            <div className="mb-4 flex items-center justify-between gap-3"><h2 className="font-bold">Scheduled jobs</h2><Button size="sm" onClick={() => setOpenForm(openForm === "cron" ? null : "cron")}><Plus className="h-4 w-4" /> Add cron job</Button></div>
            {((data.items as CronItem[]) ?? []).map((job) => (
              <div key={job.id} className="group flex justify-between border-b border-slate-100 py-4 transition-colors hover:bg-slate-50/50 px-2 rounded-lg -mx-2">
                <div>
                  <code className="text-panel-700 bg-panel-50 px-1.5 py-0.5 rounded text-xs">{job.expression}</code>
                  <p className="mt-1.5 text-sm">{job.command}</p>
                </div>
                <button aria-label={`Delete cron job ${job.expression}`} className="rounded-lg p-2 opacity-100 transition-opacity hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100" onClick={() => act({ action: "delete", id: job.id })}>
                  <Trash2 className="h-4 w-4 text-red-500" />
                </button>
              </div>
            ))}
          </section>
          {openForm === "cron" && <FormModal title="Add cron job" onClose={() => setOpenForm(null)}><form
            className="space-y-4"
            onSubmit={(e) => { submit("add", e); setOpenForm(null); }}
          >
            <h2 className="font-bold">Add cron job</h2>
            <div><Label>Schedule</Label><Input name="schedule" defaultValue="*/5 * * * *" placeholder="*/5 * * * *" required /></div>
            <div className="flex flex-wrap gap-2"><span className="w-full text-xs font-medium text-slate-500">Quick schedules</span>{[["Every 5 minutes", "*/5 * * * *"], ["Hourly", "0 * * * *"], ["Daily at midnight", "0 0 * * *"], ["Weekly", "0 0 * * 0"]].map(([label, value]) => <button key={value} type="button" className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium hover:bg-panel-50" onClick={(event) => { const form = event.currentTarget.closest("form"); const input = form?.elements.namedItem("schedule") as HTMLInputElement | null; if (input) input.value = value; }}>{label}</button>)}</div>
            <textarea
              name="command"
              placeholder="php artisan schedule:run"
              className="min-h-24 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none ring-panel-500 focus:ring-2"
              required
            />
            <p className="-mt-2 text-xs text-slate-500">Enter one command per line. Commands run in order and stop if one fails.</p>
            <div className="grid gap-2"><span className="text-xs font-medium text-slate-500">Command templates</span>{[
              ["Laravel scheduler", `cd ${data.sitePath ?? "site"} && php artisan schedule:run`],
              ["WordPress cron", `cd ${data.sitePath ?? "site"} && wp cron event run --due-now`],
              ["Node.js task", `cd ${data.sitePath ?? "site"} && npm run cron`],
            ].map(([label, command]) => <button key={label} type="button" className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-left text-sm hover:border-panel-300 hover:bg-panel-50" onClick={(event) => { const form = event.currentTarget.closest("form"); const input = form?.elements.namedItem("command") as HTMLTextAreaElement | null; if (input) input.value = command; }}><b className="block text-xs text-slate-700">{label}</b><code className="mt-1 block truncate text-xs text-slate-500">{command}</code></button>)}</div>
            {feedback}
            <Button>
              <Plus className="h-4 w-4" /> Add job
            </Button>
          </form></FormModal>}
        </div>
      );
  
    if (section === "logs")
      return (
        <section className={card}>
          <h2 className="font-bold">Log files</h2>
          <p className="mb-4 text-sm text-slate-500">{data.path}</p>
          {feedback}
          <div className="space-y-2">
            {((data.items as string[]) ?? []).map((name) => (
              <div
                key={name}
                className="group flex items-center justify-between gap-3 rounded-xl border border-slate-200/60 bg-white/50 p-2 transition-all hover:bg-white hover:shadow-sm"
              >
                <button type="button" className="min-w-0 flex-1 rounded-lg p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-panel-500" onClick={() => void readLog(name)}>
                  <code className="block truncate">{name}</code><span className="mt-1 block text-xs text-slate-400">Open recent entries</span>
                </button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { void act({ action: "clear", name }); }}
                >
                  Clear log
                </Button>
              </div>
            ))}
          </div>
          {logViewer && createPortal(<div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) setLogViewer(null); }}><div role="dialog" aria-modal="true" aria-label={`Log file ${logViewer.name}`} className="flex max-h-[calc(100vh-2rem)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"><div className="flex items-center justify-between border-b px-5 py-4"><div><h3 className="font-bold">{logViewer.name}</h3><p className="text-xs text-slate-500">{logViewer.truncated ? "Showing the most recent 500 KB" : "Complete log"}</p></div><Button aria-label="Close log viewer" variant="ghost" size="icon" onClick={() => setLogViewer(null)}><X className="h-5 w-5" /></Button></div><pre className="min-h-[50vh] flex-1 overflow-auto bg-slate-950 p-5 font-mono text-xs leading-5 text-slate-200">{logViewer.content || "This log is empty."}</pre></div></div>, document.body)}
        </section>
      );
  return null;
  }

  return (
    <>
      {renderContent()}
      {confirmAction && (
        <ConfirmDialog
          title={confirmAction.title}
          message={confirmAction.message}
          onConfirm={confirmAction.onConfirm}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </>
  );
}

function FormModal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return createPortal(<div className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-slate-950/40 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div role="dialog" aria-modal="true" aria-label={title} className="my-auto w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-2xl"><div className="flex items-center justify-between border-b border-slate-100 px-6 py-5"><div><h2 className="text-lg font-bold text-ink">{title}</h2><p className="mt-0.5 text-sm text-slate-500">Review the details before continuing.</p></div><Button aria-label={`Close ${title}`} type="button" variant="ghost" size="icon" onClick={onClose}><X className="h-5 w-5" /></Button></div><div className="p-6">{children}</div></div></div>, document.body);
}
