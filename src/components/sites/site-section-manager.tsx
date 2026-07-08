"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Database, FilePlus2, FolderPlus, KeyRound, LoaderCircle, Plus, Save, Shield, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
};

export function SiteSectionManager({ domain, section, initialData }: { domain: string; section: string; initialData: Data }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [data] = useState(initialData);

  async function act(input: Record<string, unknown>) {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(domain)}/sections/${section}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error?.message || "CloudPanel could not apply the change.");
      router.refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Operation failed."); }
    finally { setBusy(false); }
  }
  function submit(action: string, event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    void act({ action, ...values });
  }
  const card = "rounded-2xl border border-slate-200 bg-white p-6 shadow-card";
  const feedback = error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p> : null;

  if (section === "vhost") return <div className={card}>
    <form onSubmit={(e) => submit("save", e)} className="space-y-4">
      <div><h2 className="font-bold">NGINX Vhost Editor</h2><p className="text-sm text-slate-500">CloudPanel validates NGINX and rolls back invalid changes.</p></div>
      <textarea name="content" defaultValue={data.content} className="min-h-[60vh] w-full rounded-xl bg-slate-950 p-5 font-mono text-xs leading-6 text-slate-100 outline-none ring-panel-500 focus:ring-2" />
      {feedback}<Button disabled={busy}>{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save and reload NGINX</Button>
    </form>
  </div>;

  if (section === "databases") return <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
    <section className={card}><h2 className="mb-4 font-bold">Databases</h2><div className="space-y-3">{(data.items as DatabaseItem[] ?? []).map((item) => <div key={item.id} className="flex items-center justify-between rounded-xl border p-4"><div className="flex gap-3"><Database className="text-panel-600" /><div><b>{item.name}</b><p className="text-xs text-slate-500">{item.users?.join(", ") || "No users"}</p></div></div><Button variant="ghost" size="icon" onClick={() => act({action:"delete",name:item.name})}><Trash2 className="h-4 w-4 text-red-600" /></Button></div>)}{!data.items?.length && <p className="text-sm text-slate-400">No databases yet.</p>}</div></section>
    <form className={`${card} space-y-4`} onSubmit={(e) => submit("add", e)}><h2 className="font-bold">Add database</h2><div><Label>Database name</Label><Input name="name" required /></div><div><Label>User name</Label><Input name="username" required /></div><div><Label>Password</Label><Input name="password" type="password" minLength={12} required /></div>{feedback}<Button disabled={busy}><Plus className="h-4 w-4" /> Create database</Button></form>
  </div>;

  if (section === "certificates") return <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
    <section className={card}><h2 className="mb-4 font-bold">Installed certificates</h2><div className="space-y-3">{(data.items as CertificateItem[] ?? []).map((item)=><div key={item.id} className="rounded-xl border p-4"><div className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-emerald-600"/><b>{item.domains?.join(", ")}</b></div><p className="mt-2 text-xs text-slate-500">Expires {item.expiresAt || "unknown"}</p></div>)}</div></section>
    <form className={`${card} space-y-4`} onSubmit={(e)=>submit("lets-encrypt",e)}><h2 className="font-bold">Let&apos;s Encrypt</h2><p className="text-sm text-slate-500">Issue or renew a trusted certificate.</p><div><Label>Alternative names</Label><Input name="subjectAlternativeName" placeholder="www.example.com,api.example.com" /></div>{feedback}<Button disabled={busy}><Shield className="h-4 w-4"/> Issue certificate</Button></form>
  </div>;

  if (section === "security") return <div className="grid gap-5 md:grid-cols-2">
    {[{key:"blockedIps",title:"Blocked IPs",add:"add-ip",del:"delete-ip",placeholder:"203.0.113.4"},{key:"blockedBots",title:"Blocked bots",add:"add-bot",del:"delete-bot",placeholder:"BadBot"}].map(x=><section key={x.key} className={card}><h2 className="font-bold">{x.title}</h2><form className="my-4 flex gap-2" onSubmit={(e)=>submit(x.add,e)}><Input name="value" placeholder={x.placeholder} required/><Button size="icon"><Plus className="h-4 w-4"/></Button></form><div className="space-y-2">{((data[x.key] as string[] | undefined)??[]).map((v)=><div key={v} className="flex justify-between rounded-lg bg-slate-50 p-3 text-sm">{v}<button onClick={()=>act({action:x.del,value:v})}><Trash2 className="h-4 w-4 text-red-500"/></button></div>)}</div></section>)}
    <form className={`${card} space-y-4`} onSubmit={(e)=>submit("basic-auth",e)}><h2 className="font-bold">Basic authentication</h2><label className="flex gap-2 text-sm"><input name="active" type="checkbox" value="true" defaultChecked={data.basicAuth?.active}/> Enabled</label><Input name="username" placeholder="User name" defaultValue={data.basicAuth?.username}/><Input name="password" type="password" placeholder="New password"/>{feedback}<Button disabled={busy}>Save protection</Button></form>
    <section className={card}><h2 className="font-bold">Cloudflare protection</h2><p className="mt-2 text-sm text-slate-500">Reject traffic that does not originate from Cloudflare&apos;s published networks.</p><Button className="mt-4" variant={data.cloudflareOnly ? "danger" : "default"} onClick={()=>act({action:"cloudflare",enabled:!data.cloudflareOnly})}>{data.cloudflareOnly ? "Disable Cloudflare-only traffic" : "Enable Cloudflare-only traffic"}</Button></section>
  </div>;

  if (section === "users") return <div className="grid gap-5 md:grid-cols-2"><section className={card}><h2 className="font-bold">SSH users</h2><p className="my-3 text-sm">Primary: <b>{data.primary}</b></p>{(data.ssh??[]).map((u)=><div key={u} className="flex justify-between border-t py-3">{u}<button onClick={()=>act({action:"delete-ssh",username:u})}><Trash2 className="h-4 w-4 text-red-500"/></button></div>)}<form className="mt-4 space-y-3" onSubmit={(e)=>submit("add-ssh",e)}><Input name="username" placeholder="SSH user" required/><Input name="password" type="password" placeholder="Password" required/><textarea name="sshKeys" className="w-full rounded-lg border p-3 text-sm" placeholder="Optional public key"/><Button><Plus className="h-4 w-4"/> Add SSH user</Button></form></section><section className={card}><h2 className="font-bold">FTP users</h2>{(data.ftp??[]).map((u)=><div key={u.username} className="flex justify-between border-b py-3"><div>{u.username}<p className="text-xs text-slate-400">{u.home}</p></div><button onClick={()=>act({action:"delete-ftp",username:u.username})}><Trash2 className="h-4 w-4 text-red-500"/></button></div>)}<form className="mt-4 space-y-3" onSubmit={(e)=>submit("add-ftp",e)}><Input name="username" placeholder="FTP user" required/><Input name="password" type="password" placeholder="Password" required/><Input name="homeDirectory" placeholder="Home directory"/><Button><Plus className="h-4 w-4"/> Add FTP user</Button></form>{feedback}</section></div>;

  if (section === "file-manager") return <section className={card}><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-bold">{data.path}</h2><p className="text-sm text-slate-500">Site root files and folders</p></div><div className="flex gap-2"><form onSubmit={(e)=>submit("new-file",e)} className="flex gap-2"><Input name="name" placeholder="new-file.txt" required/><Button variant="outline"><FilePlus2 className="h-4 w-4"/> File</Button></form><form onSubmit={(e)=>submit("new-folder",e)} className="flex gap-2"><Input name="name" placeholder="folder" required/><Button variant="outline"><FolderPlus className="h-4 w-4"/> Folder</Button></form></div></div>{feedback}<div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{(data.items as string[]??[]).map((name)=><div key={name} className="flex items-center justify-between rounded-xl border p-3 text-sm"><span className="truncate">{name}</span><button onClick={()=>act({action:"delete",name})}><Trash2 className="h-4 w-4 text-red-500"/></button></div>)}</div></section>;

  if (section === "cron-jobs") return <div className="grid gap-5 lg:grid-cols-[1fr_360px]"><section className={card}><h2 className="mb-4 font-bold">Scheduled jobs</h2>{(data.items as CronItem[]??[]).map((job)=><div key={job.id} className="flex justify-between border-b py-4"><div><code className="text-panel-700">{job.expression}</code><p className="mt-1 text-sm">{job.command}</p></div><button onClick={()=>act({action:"delete",id:job.id})}><Trash2 className="h-4 w-4 text-red-500"/></button></div>)}</section><form className={`${card} space-y-4`} onSubmit={(e)=>submit("add",e)}><h2 className="font-bold">Add cron job</h2><Input name="schedule" placeholder="*/5 * * * *" required/><Input name="command" placeholder="php artisan schedule:run" required/>{feedback}<Button><Plus className="h-4 w-4"/> Add job</Button></form></div>;

  if (section === "logs") return <section className={card}><h2 className="font-bold">Log files</h2><p className="mb-4 text-sm text-slate-500">{data.path}</p>{feedback}<div className="space-y-2">{(data.items as string[]??[]).map((name)=><div key={name} className="flex items-center justify-between rounded-xl border p-4"><code>{name}</code><Button variant="outline" size="sm" onClick={()=>act({action:"clear",name})}>Clear log</Button></div>)}</div></section>;
  return null;
}
