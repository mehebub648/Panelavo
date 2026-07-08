"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  Copy,
  Database,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Plus,
  Save,
  Shield,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { FileManager, type FileManagerData } from "@/components/sites/file-manager";
import { CodeEditor, preloadCodeEditor } from "@/components/ui/code-editor";

type DatabaseItem = { id: string; name: string; users?: string[] };
type CertificateItem = { id: string; domains?: string[]; expiresAt?: string };
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
  keyPair?: { exists?: boolean; publicKey?: string; privateKeyMasked?: string; fingerprint?: string };
};

export function SiteSectionManager({
  domain,
  section,
  initialData,
}: {
  domain: string;
  section: string;
  initialData: Data;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const data = initialData;
  const [openForm, setOpenForm] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState(String(initialData.content ?? ""));
  const [savedEditorContent, setSavedEditorContent] = useState(String(initialData.content ?? ""));

  async function act(input: Record<string, unknown>) {
    if (busy) return false;
    if (
      String(input.action).includes("delete") &&
      !window.confirm("Remove this item? This action cannot be undone.")
    )
      return false;
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
    void act({ action, ...values });
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
      <div className={`grid gap-5 ${openForm === "database" ? "lg:grid-cols-[1fr_360px]" : ""}`}>
        <section className={card}>
          <div className="mb-4 flex items-center justify-between gap-3"><h2 className="font-bold">Databases</h2><Button size="sm" onClick={() => setOpenForm(openForm === "database" ? null : "database")}><Plus className="h-4 w-4" /> Add database</Button></div>
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
                <Button
                  variant="ghost"
                  size="icon"
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => act({ action: "delete", name: item.name })}
                >
                  <Trash2 className="h-4 w-4 text-red-500 hover:text-red-600" />
                </Button>
              </div>
            ))}
            {!data.items?.length && (
              <p className="text-sm text-slate-400">No databases yet.</p>
            )}
          </div>
        </section>
        {openForm === "database" && <form
          className={`${card} space-y-4`}
          onSubmit={(e) => { submit("add", e); setOpenForm(null); }}
        >
          <h2 className="font-bold">Add database</h2>
          <div>
            <Label>Database name</Label>
            <Input name="name" required />
          </div>
          <div>
            <Label>User name</Label>
            <Input name="username" required />
          </div>
          <div>
            <Label>Password</Label>
            <Input name="password" type="password" minLength={12} required />
          </div>
          {feedback}
          <Button disabled={busy}>
            <Plus className="h-4 w-4" /> Create database
          </Button>
        </form>}
      </div>
    );

  if (section === "certificates")
    return (
      <div className={`grid gap-5 ${openForm === "certificate" ? "lg:grid-cols-[1fr_360px]" : ""}`}>
        <section className={card}>
          <div className="mb-4 flex items-center justify-between gap-3"><h2 className="font-bold">Installed certificates</h2><Button size="sm" onClick={() => setOpenForm(openForm === "certificate" ? null : "certificate")}><Shield className="h-4 w-4" /> Issue certificate</Button></div>
          <div className="space-y-3">
            {((data.items as CertificateItem[]) ?? []).map((item) => (
              <div key={item.id} className="group rounded-xl border border-slate-200/60 bg-white/50 p-4 transition-all hover:bg-white hover:shadow-sm">
                <div className="flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-emerald-600" />
                  <b>{item.domains?.join(", ")}</b>
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  Expires {item.expiresAt || "unknown"}
                </p>
              </div>
            ))}
          </div>
        </section>
        {openForm === "certificate" && <form
          className={`${card} space-y-4`}
          onSubmit={(e) => submit("lets-encrypt", e)}
        >
          <h2 className="font-bold">Let&apos;s Encrypt</h2>
          <p className="text-sm text-slate-500">
            Issue or renew a trusted certificate.
          </p>
          <div>
            <Label>Alternative names</Label>
            <Input
              name="subjectAlternativeName"
              placeholder="www.example.com,api.example.com"
            />
          </div>
          {feedback}
          <Button disabled={busy}>
            <Shield className="h-4 w-4" /> Issue certificate
          </Button>
        </form>}
      </div>
    );

  if (section === "security")
    return (
      <div className="grid gap-5 md:grid-cols-2">
        {[
          {
            key: "blockedIps",
            title: "Blocked IPs",
            add: "add-ip",
            del: "delete-ip",
            placeholder: "203.0.113.4",
          },
          {
            key: "blockedBots",
            title: "Blocked bots",
            add: "add-bot",
            del: "delete-bot",
            placeholder: "BadBot",
          },
        ].map((x) => (
          <section key={x.key} className={card}>
            <h2 className="font-bold">{x.title}</h2>
            <form
              className="my-4 flex gap-2"
              onSubmit={(e) => submit(x.add, e)}
            >
              <Input name="value" placeholder={x.placeholder} required />
              <Button size="icon">
                <Plus className="h-4 w-4" />
              </Button>
            </form>
            <div className="space-y-2">
              {((data[x.key] as string[] | undefined) ?? []).map((v) => (
                <div
                  key={v}
                  className="group flex justify-between rounded-lg border border-slate-200/60 bg-slate-50/50 p-3 text-sm transition-all hover:bg-white hover:shadow-sm"
                >
                  {v}
                  <button className="opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => act({ action: x.del, value: v })}>
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </button>
                </div>
              ))}
            </div>
          </section>
        ))}
        <form
          className={`${card} space-y-4`}
          onSubmit={(e) => submit("basic-auth", e)}
        >
          <h2 className="font-bold">Basic authentication</h2>
          <label className="flex gap-2 text-sm">
            <input
              name="active"
              type="checkbox"
              value="true"
              defaultChecked={data.basicAuth?.active}
            />{" "}
            Enabled
          </label>
          <Input
            name="username"
            placeholder="User name"
            defaultValue={data.basicAuth?.username}
          />
          <Input name="password" type="password" placeholder="New password" />
          {feedback}
          <Button disabled={busy}>Save protection</Button>
        </form>
        <section className={card}>
          <h2 className="font-bold">Cloudflare protection</h2>
          <p className="mt-2 text-sm text-slate-500">
            Reject traffic that does not originate from Cloudflare&apos;s
            published networks.
          </p>
          <Button
            className="mt-4"
            variant={data.cloudflareOnly ? "danger" : "default"}
            onClick={() =>
              act({ action: "cloudflare", enabled: !data.cloudflareOnly })
            }
          >
            {data.cloudflareOnly
              ? "Disable Cloudflare-only traffic"
              : "Enable Cloudflare-only traffic"}
          </Button>
        </section>
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
            <div className="rounded-xl border border-amber-200/70 bg-amber-50/50 p-4"><div className="mb-2 flex items-center gap-2"><EyeOff className="h-4 w-4 text-amber-600" /><Label>Private key</Label></div><pre className="overflow-hidden whitespace-pre-wrap rounded-lg bg-slate-900 p-3 text-xs leading-5 text-slate-400">{data.keyPair.privateKeyMasked}</pre><p className="mt-2 text-xs text-amber-700">Private key material is intentionally never sent to the browser.</p></div>
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
          {openForm === "ssh" && <form
            className="mt-4 space-y-3"
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
          </form>}
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
          {openForm === "ftp" && <form
            className="mt-4 space-y-3"
            onSubmit={(e) => { submit("add-ftp", e); setOpenForm(null); }}
          >
            <Input name="username" placeholder="FTP user" required />
            <Input
              name="password"
              type="password"
              placeholder="Password"
              required
            />
            <Input name="homeDirectory" placeholder="Home directory" />
            <Button>
              <Plus className="h-4 w-4" /> Add FTP user
            </Button>
          </form>}
          {feedback}
        </section>
      </div>
    );

  if (section === "file-manager")
    return <FileManager domain={domain} initialData={data as FileManagerData} />;

  if (section === "cron-jobs")
    return (
      <div className={`grid gap-5 ${openForm === "cron" ? "lg:grid-cols-[1fr_360px]" : ""}`}>
        <section className={card}>
          <div className="mb-4 flex items-center justify-between gap-3"><h2 className="font-bold">Scheduled jobs</h2><Button size="sm" onClick={() => setOpenForm(openForm === "cron" ? null : "cron")}><Plus className="h-4 w-4" /> Add cron job</Button></div>
          {((data.items as CronItem[]) ?? []).map((job) => (
            <div key={job.id} className="group flex justify-between border-b border-slate-100 py-4 transition-colors hover:bg-slate-50/50 px-2 rounded-lg -mx-2">
              <div>
                <code className="text-panel-700 bg-panel-50 px-1.5 py-0.5 rounded text-xs">{job.expression}</code>
                <p className="mt-1.5 text-sm">{job.command}</p>
              </div>
              <button className="opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => act({ action: "delete", id: job.id })}>
                <Trash2 className="h-4 w-4 text-red-500" />
              </button>
            </div>
          ))}
        </section>
        {openForm === "cron" && <form
          className={`${card} space-y-4`}
          onSubmit={(e) => { submit("add", e); setOpenForm(null); }}
        >
          <h2 className="font-bold">Add cron job</h2>
          <Input name="schedule" placeholder="*/5 * * * *" required />
          <Input
            name="command"
            placeholder="php artisan schedule:run"
            required
          />
          {feedback}
          <Button>
            <Plus className="h-4 w-4" /> Add job
          </Button>
        </form>}
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
              className="group flex items-center justify-between rounded-xl border border-slate-200/60 bg-white/50 p-4 transition-all hover:bg-white hover:shadow-sm"
            >
              <code>{name}</code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => act({ action: "clear", name })}
              >
                Clear log
              </Button>
            </div>
          ))}
        </div>
      </section>
    );
  return null;
}
