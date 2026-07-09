"use client";
import { useEffect, useState } from "react";
import { Cloud, LoaderCircle, Pencil, Plus, RefreshCw, Trash2, Globe, ChevronRight, Server, ShieldCheck, Mail, FileText, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PromptDialog } from "@/components/ui/prompt-dialog";

type Credential = { id: string; label: string; createdAt: string };
type Zone = { id: string; name: string; credentialId: string; credentialLabel: string };
type Record = { id: string; type: string; name: string; content: string; proxied: boolean; ttl: number };

export function DomainManager() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [selected, setSelected] = useState<Zone | null>(null);
  const [records, setRecords] = useState<Record[]>([]);
  const [busy, setBusy] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [addingCredential, setAddingCredential] = useState(false);
  const [addingRecord, setAddingRecord] = useState(false);
  const [editingRecord, setEditingRecord] = useState<Record | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);
  const [promptAction, setPromptAction] = useState<{ title: string; message: string; onConfirm: (val: string) => void } | null>(null);

  async function load(refresh = false) {
    setBusy(true);
    try {
      const [c, z] = await Promise.all([
        fetch("/api/cloudflare/credentials").then((r) => r.json()),
        fetch(`/api/cloudflare/zones${refresh ? "?refresh=true" : ""}`).then((r) => r.json()),
      ]);
      if (!c.success) throw new Error(c.error.message);
      if (!z.success) throw new Error(z.error.message);
      setCredentials(c.data.credentials);
      setZones(z.data.zones);
      
      // Auto-select first domain if none selected
      if (!selected && z.data.zones.length > 0) {
         void select(z.data.zones[0]);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load domains");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function select(zone: Zone) {
    setSelected(zone);
    setBusy(true);
    try {
      const result = await fetch(
        `/api/cloudflare/records?credentialId=${encodeURIComponent(zone.credentialId)}&zoneId=${encodeURIComponent(zone.id)}`
      ).then((r) => r.json());
      if (!result.success) throw new Error(result.error.message);
      setRecords(result.data.records);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load DNS records");
    } finally {
      setBusy(false);
    }
  }

  async function addCredential(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const result = await fetch("/api/cloudflare/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      }).then((r) => r.json());
      if (!result.success) throw new Error(result.error.message);
      setAddingCredential(false);
      toast.success("Cloudflare account connected");
      await load(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Connection failed");
      setBusy(false);
    }
  }

  async function removeCredential(item: Credential) {
    setPromptAction({
      title: "Disconnect Cloudflare",
      message: `Type CONFIRM to disconnect ${item.label}. DNS records will not be changed.`,
      onConfirm: async (val) => {
        if (val !== "CONFIRM") {
          toast.error("You must type CONFIRM to disconnect");
          return;
        }
        setPromptAction(null);
        setBusy(true);
        try {
          const result = await fetch("/api/cloudflare/credentials", {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: item.id }),
          }).then((r) => r.json());
          if (!result.success) throw new Error(result.error.message);
          if (selected?.credentialId === item.id) {
            setSelected(null);
            setRecords([]);
          }
          await load(true);
          toast.success("Cloudflare account disconnected");
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Could not disconnect account");
          setBusy(false);
        }
      },
    });
  }

  async function addRecord(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const result = await fetch("/api/cloudflare/records", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: editingRecord ? "update" : "create",
          id: editingRecord?.id,
          credentialId: selected.credentialId,
          zoneId: selected.id,
          record: { ...values, ttl: 1, proxied: values.proxied === "true" },
        }),
      }).then((r) => r.json());
      if (!result.success) throw new Error(result.error.message);
      setAddingRecord(false);
      setEditingRecord(null);
      toast.success(editingRecord ? "DNS record updated" : "DNS record created");
      await select(selected);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save record");
      setBusy(false);
    }
  }

  async function removeRecord(record: Record) {
    if (!selected) return;
    setConfirmAction({
      title: "Delete DNS record",
      message: `Are you sure you want to delete ${record.name}?`,
      onConfirm: async () => {
        setConfirmAction(null);
        await fetch("/api/cloudflare/records", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "delete",
            id: record.id,
            credentialId: selected.credentialId,
            zoneId: selected.id,
          }),
        });
        await select(selected);
      },
    });
  }

  const groupedRecords = records.reduce((acc, record) => {
    let group = "Other Records";
    if (record.type === "A" || record.type === "AAAA") group = "IPv4/IPv6 Addresses";
    else if (record.type === "CNAME") group = "Canonical Names";
    else if (record.type === "MX") group = "Mail Servers";
    else if (record.type === "TXT") group = "Text Records";

    acc[group] = acc[group] || [];
    acc[group].push(record);
    return acc;
  }, {} as { [key: string]: Record[] });

  // Custom ordering for groups
  const groupOrder = ["IPv4/IPv6 Addresses", "Canonical Names", "Mail Servers", "Text Records", "Other Records"];
  const sortedGroups = Object.entries(groupedRecords).sort(([a], [b]) => groupOrder.indexOf(a) - groupOrder.indexOf(b));

  const filteredZones = zones.filter(z => z.name.toLowerCase().includes(searchQuery.toLowerCase()));

  return (
    <div className="mx-auto max-w-7xl space-y-8 animate-in fade-in duration-300">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-slate-900">Domains & DNS</h2>
          <p className="mt-2 text-slate-500 max-w-2xl">
            Manage your Cloudflare domains, DNS records, and connected accounts from a single unified interface.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={() => void load(true)} className="bg-white hover:bg-slate-50">
            <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button onClick={() => setAddingCredential(true)} className="shadow-sm">
            <Cloud className="h-4 w-4" /> Connect Cloudflare
          </Button>
        </div>
      </div>

      {!!credentials.length && (
        <div className="flex flex-wrap gap-3">
          {credentials.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-2 rounded-full border border-slate-200/60 bg-white/50 backdrop-blur-sm py-1.5 pl-4 pr-1.5 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-white"
            >
              <div className="flex items-center gap-2">
                <Cloud className="h-4 w-4 text-panel-500" />
                {item.label}
              </div>
              <button
                className="ml-2 flex h-6 w-6 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500"
                onClick={() => void removeCredential(item)}
                aria-label={`Disconnect ${item.label}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {!credentials.length && !busy ? (
        <section className="rounded-3xl border border-dashed border-slate-300 bg-white/50 backdrop-blur-sm px-6 py-16 text-center shadow-sm">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-panel-50 text-panel-600 mb-6">
            <Cloud className="h-8 w-8" />
          </div>
          <h3 className="text-xl font-bold text-slate-900">Connect your Cloudflare account</h3>
          <p className="mx-auto mt-3 max-w-md text-slate-500 leading-relaxed">
            Use an API token with Zone:Read and DNS:Edit permissions. Tokens are securely encrypted and isolated.
          </p>
          <Button className="mt-8" onClick={() => setAddingCredential(true)} size="lg">
            Connect your first account
          </Button>
        </section>
      ) : (
        <div className="flex flex-col lg:flex-row gap-6 items-start">
          {/* Sidebar */}
          <div className="w-full lg:w-80 flex-shrink-0 space-y-4">
             <div className="bg-white rounded-2xl shadow-card border border-white/40 overflow-hidden flex flex-col max-h-[calc(100vh-12rem)]">
               <div className="p-4 border-b border-slate-100 bg-slate-50/50">
                 <div className="flex justify-between items-center mb-3">
                   <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                     <Globe className="h-4 w-4 text-slate-500" /> Your Domains
                   </h3>
                   <span className="text-xs font-semibold bg-panel-100 text-panel-700 px-2 py-0.5 rounded-full">{zones.length}</span>
                 </div>
                 <div className="relative">
                   <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                   <Input 
                     placeholder="Search domains..." 
                     className="pl-9 h-9 bg-white text-sm"
                     value={searchQuery}
                     onChange={e => setSearchQuery(e.target.value)}
                   />
                 </div>
               </div>
               <div className="divide-y divide-slate-100 overflow-y-auto flex-1 p-2 space-y-1">
                  {filteredZones.map(zone => (
                     <button
                       key={zone.id}
                       onClick={() => select(zone)}
                       className={`w-full text-left px-4 py-3 rounded-xl flex items-center justify-between transition-all duration-200 ${selected?.id === zone.id ? 'bg-panel-50 shadow-sm ring-1 ring-panel-500/20' : 'hover:bg-slate-50'}`}
                     >
                       <div className="overflow-hidden">
                         <div className={`font-semibold truncate ${selected?.id === zone.id ? 'text-panel-700' : 'text-slate-700'}`}>{zone.name}</div>
                         <div className="text-[11px] font-medium text-slate-400 mt-0.5 uppercase tracking-wider flex items-center gap-1.5 truncate">
                           <Cloud className="h-3 w-3" /> {zone.credentialLabel}
                         </div>
                       </div>
                       <ChevronRight className={`h-4 w-4 shrink-0 transition-transform ${selected?.id === zone.id ? 'text-panel-600 translate-x-0.5' : 'text-slate-300'}`} />
                     </button>
                  ))}
                  {filteredZones.length === 0 && !busy && (
                    <div className="p-8 text-center text-sm text-slate-500 flex flex-col items-center gap-2">
                      <Search className="h-6 w-6 text-slate-300" />
                      No domains found
                    </div>
                  )}
               </div>
             </div>
          </div>

          {/* Main Content */}
          <div className="flex-1 w-full min-w-0">
             {selected ? (
                <div className="bg-white rounded-2xl shadow-card border border-white/40 overflow-hidden min-h-[500px] flex flex-col animate-in fade-in slide-in-from-bottom-4 duration-300">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-6 border-b border-slate-100">
                    <div>
                      <h3 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                        {selected.name}
                        <a href={`https://${selected.name}`} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-panel-600 transition-colors">
                          <Globe className="h-4 w-4" />
                        </a>
                      </h3>
                      <p className="mt-1 text-sm text-slate-500">
                        {records.length} DNS records configured
                      </p>
                    </div>
                    <Button
                      onClick={() => {
                        setEditingRecord(null);
                        setAddingRecord(true);
                      }}
                      className="shrink-0"
                    >
                      <Plus className="h-4 w-4" /> Add record
                    </Button>
                  </div>
                  
                  <div className="overflow-x-auto flex-1 bg-slate-50/30">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50/80 text-left text-xs font-semibold uppercase tracking-wider text-slate-500 border-b border-slate-100">
                        <tr>
                          <th className="px-6 py-4 w-24">Type</th>
                          <th className="px-6 py-4">Name</th>
                          <th className="px-6 py-4">Content</th>
                          <th className="px-6 py-4 w-32">Proxy</th>
                          <th className="px-6 py-4 w-24 text-right">Actions</th>
                        </tr>
                      </thead>
                      {sortedGroups.map(([groupName, groupRecords]) => (
                        <tbody key={groupName} className="divide-y divide-slate-100/60 bg-white">
                          <tr>
                            <td
                              colSpan={5}
                              className="bg-slate-50/50 px-6 py-2 text-[11px] font-bold uppercase tracking-wider text-slate-500 shadow-inner shadow-slate-100/50"
                            >
                              <div className="flex items-center gap-2">
                                {groupName === "IPv4/IPv6 Addresses" && <Server className="h-3.5 w-3.5" />}
                                {groupName === "Canonical Names" && <Globe className="h-3.5 w-3.5" />}
                                {groupName === "Mail Servers" && <Mail className="h-3.5 w-3.5" />}
                                {groupName === "Text Records" && <FileText className="h-3.5 w-3.5" />}
                                {groupName}
                              </div>
                            </td>
                          </tr>
                          {groupRecords.map((record) => (
                            <tr key={record.id} className="group hover:bg-slate-50/50 transition-colors">
                              <td className="px-6 py-3">
                                <span className={`inline-flex items-center rounded-md px-2 py-1 font-mono text-xs font-medium ${record.type === 'A' || record.type === 'AAAA' ? 'bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-700/10' : record.type === 'CNAME' ? 'bg-purple-50 text-purple-700 ring-1 ring-inset ring-purple-700/10' : record.type === 'MX' ? 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-700/10' : 'bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-700/10'}`}>
                                  {record.type}
                                </span>
                              </td>
                              <td className="px-6 py-3 font-semibold text-slate-700">{record.name}</td>
                              <td className="px-6 py-3 font-mono text-xs text-slate-600 max-w-[200px] truncate" title={record.content}>
                                {record.content}
                              </td>
                              <td className="px-6 py-3 whitespace-nowrap">
                                {record.proxied ? (
                                  <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-50 px-2.5 py-1 text-xs font-medium text-orange-700 ring-1 ring-inset ring-orange-600/20">
                                    <Cloud className="h-3 w-3" /> Proxied
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-500/10">
                                    DNS only
                                  </span>
                                )}
                              </td>
                              <td className="px-6 py-3 text-right opacity-0 group-hover:opacity-100 transition-opacity">
                                <div className="flex justify-end gap-1">
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 hover:bg-slate-200/50 hover:text-slate-900"
                                    onClick={() => {
                                      setEditingRecord(record);
                                      setAddingRecord(true);
                                    }}
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 hover:bg-red-50 hover:text-red-600 text-slate-400"
                                    onClick={() => void removeRecord(record)}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      ))}
                      {!records.length && !busy && (
                        <tbody>
                          <tr>
                            <td colSpan={5} className="px-6 py-12 text-center">
                               <div className="flex flex-col items-center justify-center text-slate-400">
                                 <Server className="h-8 w-8 mb-3 opacity-20" />
                                 <p className="text-sm font-medium">No DNS records found</p>
                                 <p className="text-xs mt-1">Add a record to start routing traffic</p>
                               </div>
                            </td>
                          </tr>
                        </tbody>
                      )}
                    </table>
                  </div>
                </div>
             ) : (
               <div className="h-full min-h-[500px] rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50/50 flex flex-col items-center justify-center text-slate-400">
                  <div className="h-16 w-16 bg-white shadow-sm rounded-2xl flex items-center justify-center mb-4">
                    <Globe className="h-8 w-8 text-slate-300" />
                  </div>
                  <h3 className="text-lg font-bold text-slate-700 mb-1">Select a Domain</h3>
                  <p className="text-sm max-w-sm text-center leading-relaxed">Choose a domain from the sidebar to manage its DNS records, or connect a new Cloudflare account to import zones.</p>
               </div>
             )}
          </div>
        </div>
      )}

      {/* Modals and dialogs stay exactly the same */}
      {busy && (
        <div className="fixed bottom-6 right-6 flex items-center gap-3 rounded-xl bg-slate-900 px-5 py-3.5 text-sm font-medium text-white shadow-2xl animate-in slide-in-from-bottom-4 duration-300 z-50">
          <LoaderCircle className="h-4 w-4 animate-spin text-slate-400" /> Syncing with Cloudflare…
        </div>
      )}
      {addingCredential && (
        <Modal title="Connect Cloudflare" close={() => setAddingCredential(false)}>
          <form className="space-y-4" onSubmit={addCredential}>
            <div>
              <Label>Account label</Label>
              <Input name="label" placeholder="e.g. Production Account" required autoFocus />
            </div>
            <div>
              <Label>API token</Label>
              <Input name="token" type="password" autoComplete="off" required placeholder="••••••••••••••••••••••••" />
              <p className="mt-2 text-xs text-slate-500 bg-slate-50 p-2 rounded-lg border border-slate-100 flex gap-2">
                <ShieldCheck className="h-4 w-4 shrink-0 text-panel-500" />
                Required permissions: Zone Read and DNS Edit. Tokens are stored securely.
              </p>
            </div>
            <div className="pt-2 flex justify-end gap-2">
               <Button type="button" variant="ghost" onClick={() => setAddingCredential(false)}>Cancel</Button>
               <Button disabled={busy}>Verify & Connect</Button>
            </div>
          </form>
        </Modal>
      )}
      {addingRecord && selected && (
        <Modal
          title={`${editingRecord ? "Edit" : "Add"} DNS Record`}
          close={() => {
            setAddingRecord(false);
            setEditingRecord(null);
          }}
        >
          <form className="space-y-4" onSubmit={addRecord}>
            <div className="flex items-center gap-2 mb-4 bg-slate-50 p-3 rounded-lg border border-slate-100 text-sm">
               <Globe className="h-4 w-4 text-slate-500" />
               <span className="font-semibold text-slate-700">{selected.name}</span>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-1">
                <Label>Type</Label>
                <select
                  name="type"
                  defaultValue={editingRecord?.type ?? "A"}
                  className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm focus:ring-2 focus:ring-panel-500 outline-none"
                >
                  <option>A</option>
                  <option>AAAA</option>
                  <option>CNAME</option>
                  <option>TXT</option>
                  <option>MX</option>
                </select>
              </div>
              <div className="col-span-2">
                <Label>Name</Label>
                <div className="relative">
                  <Input name="name" defaultValue={editingRecord?.name ?? selected.name} required className="font-mono text-sm pr-20" />
                </div>
              </div>
            </div>
            <div>
              <Label>Content</Label>
              <Input name="content" defaultValue={editingRecord?.content} required className="font-mono text-sm" placeholder="e.g. 192.0.2.1 or example.com" />
            </div>
            <div className="pt-2">
              <label className="flex items-start gap-3 p-3 border border-slate-200 rounded-lg cursor-pointer hover:bg-slate-50 transition-colors">
                <input
                  type="checkbox"
                  name="proxied"
                  value="true"
                  defaultChecked={editingRecord?.proxied ?? true}
                  className="mt-1 rounded border-slate-300 text-panel-600 focus:ring-panel-600"
                />
                <div>
                  <div className="text-sm font-semibold text-slate-900">Proxy through Cloudflare</div>
                  <div className="text-xs text-slate-500 mt-0.5">Hides your origin server IP and provides DDoS protection, caching, and SSL.</div>
                </div>
              </label>
            </div>
            <div className="pt-4 flex justify-end gap-2 border-t border-slate-100 mt-6">
              <Button type="button" variant="ghost" onClick={() => { setAddingRecord(false); setEditingRecord(null); }}>Cancel</Button>
              <Button disabled={busy}>{editingRecord ? "Save Record" : "Add Record"}</Button>
            </div>
          </form>
        </Modal>
      )}
      {confirmAction && (
        <ConfirmDialog
          title={confirmAction.title}
          message={confirmAction.message}
          onConfirm={confirmAction.onConfirm}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {promptAction && (
        <PromptDialog
          title={promptAction.title}
          message={promptAction.message}
          placeholder="Type CONFIRM"
          confirmText="Disconnect"
          variant="danger"
          onConfirm={promptAction.onConfirm}
          onCancel={() => setPromptAction(null)}
        />
      )}
    </div>
  );
}

function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-2xl animate-in zoom-in-95 duration-200">
        <div className="mb-6 flex justify-between items-center border-b border-slate-100 pb-4">
          <h3 className="text-lg font-bold text-slate-900">{title}</h3>
          <button onClick={close} className="text-slate-400 hover:text-slate-600 transition-colors rounded-full p-1 hover:bg-slate-100"><Trash2 className="h-0 w-0" /> {/* Just for close icon size... let's use text instead since lucide X isn't passed */} <span className="text-xl leading-none block h-6 w-6 text-center">&times;</span></button>
        </div>
        {children}
      </div>
    </div>
  );
}
