"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Archive, ChevronRight, Copy, Download, File, FileCode2, FilePlus2, Folder,
  FolderOpen, FolderPlus, Home, KeyRound, LoaderCircle, Pencil, RefreshCw, Scissors,
  Save, Search, Trash2, Upload, X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CodeEditor, languageForFile } from "@/components/ui/code-editor";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export type FileManagerItem = {
  name: string; type: "file" | "directory"; size: number; modified: string; permissions?: string;
};
export type FileManagerData = { path: string; relativePath?: string; items?: FileManagerItem[] };

function formatSize(bytes: number) {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  timeZone: "UTC", timeZoneName: "short",
});

function formatModified(value: string) {
  return value ? dateFormatter.format(new Date(value)) : "—";
}

export function FileManager({ domain, initialData }: { domain: string; initialData: FileManagerData }) {
  const [data, setData] = useState(initialData);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<null | { kind: "file" | "folder" | "rename" | "edit" | "permissions" | "compress"; name?: string; content?: string; originalContent?: string; value?: string }>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<null | { x: number; y: number; item: FileManagerItem }>(null);
  const [clipboard, setClipboard] = useState<null | { source: string; mode: "copy" | "cut" }>(null);
  const [confirmAction, setConfirmAction] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const current = data.relativePath ?? "";
  const items = useMemo(() => (data.items ?? []).filter((item) => item.name.toLowerCase().includes(search.toLowerCase())), [data.items, search]);
  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("click", close); window.removeEventListener("blur", close); };
  }, []);

  async function request(input: Record<string, unknown>, success?: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(domain)}/sections/file-manager`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error?.message || "File operation failed.");
      if (result.data?.items) setData(result.data);
      if (success) toast.success(success);
      return result.data as FileManagerData & { content?: string };
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "File operation failed.");
    } finally { setBusy(false); }
  }
  function browse(path: string) { void request({ action: "list", path }); }
  async function open(item: FileManagerItem) {
    const path = [current, item.name].filter(Boolean).join("/");
    if (item.type === "directory") return browse(path);
    const result = await request({ action: "read", path });
    if (result?.content !== undefined) setModal({ kind: "edit", name: item.name, content: result.content, originalContent: result.content });
  }
  async function download(item: FileManagerItem) {
    const result = await request({ action: "read", path: [current, item.name].filter(Boolean).join("/"), encoding: "base64" });
    if (result?.content === undefined) return;
    const bytes = Uint8Array.from(atob(result.content), (char) => char.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes]));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = item.name; anchor.click(); URL.revokeObjectURL(url);
  }
  async function remove(item: FileManagerItem) {
    setConfirmAction({
      title: "Delete item",
      message: `Are you sure you want to delete ${item.name}${item.type === "directory" ? " and everything inside it" : ""}?`,
      onConfirm: async () => {
        setConfirmAction(null);
        await request({ action: "delete", path: current, name: item.name }, "Deleted");
      }
    });
  }
  async function upload(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      const content = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); reader.readAsDataURL(file); });
      await request({ action: "upload", path: current, name: file.name, content });
    }
    await request({ action: "list", path: current }, `${files.length} file${files.length === 1 ? "" : "s"} uploaded`);
  }
  const crumbs = current ? current.split("/") : [];
  async function itemAction(action: string, item: FileManagerItem, extra: Record<string, unknown> = {}, message?: string) {
    await request({ action, path: current, name: item.name, ...extra }, message);
    setMenu(null);
  }
  function showMenu(event: React.MouseEvent, item: FileManagerItem) {
    event.preventDefault(); setSelected(item.name);
    setMenu({ x: event.clientX, y: event.clientY, item });
  }
  // Positions the context menu once it has rendered: the menu height varies
  // with the item type, so clamp against its real size to keep it on screen.
  function placeMenu(node: HTMLDivElement | null) {
    if (!node || !menu) return;
    const rect = node.getBoundingClientRect();
    node.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))}px`;
    node.style.visibility = "visible";
  }

  return <section className="overflow-hidden rounded-2xl border border-white/60 bg-white/70 shadow-card backdrop-blur-md">
    <div className="border-b border-slate-200/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2"><FolderOpen className="h-5 w-5 text-panel-600" /><div><h2 className="font-bold">Website files</h2><p className="max-w-md truncate text-xs text-slate-500">{data.path}</p></div></div>
        <div className="flex flex-wrap gap-2">
          <input ref={uploadRef} type="file" multiple className="hidden" onChange={(e) => void upload(e.target.files)} />
          <Button variant="outline" onClick={() => uploadRef.current?.click()}><Upload className="h-4 w-4" /> Upload</Button>
          <Button variant="outline" onClick={() => setModal({ kind: "file" })}><FilePlus2 className="h-4 w-4" /> New file</Button>
          <Button onClick={() => setModal({ kind: "folder" })}><FolderPlus className="h-4 w-4" /> New folder</Button>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <nav className="flex min-w-0 items-center text-sm text-slate-600">
          <button onClick={() => browse("")} className="rounded p-1 hover:bg-slate-100" aria-label="User home"><Home className="h-4 w-4" /></button>
          {crumbs.map((crumb, i) => <span key={`${crumb}-${i}`} className="flex min-w-0 items-center"><ChevronRight className="h-4 w-4 text-slate-300" /><button className="max-w-40 truncate rounded px-1.5 py-1 hover:bg-slate-100" onClick={() => browse(crumbs.slice(0, i + 1).join("/"))}>{crumb}</button></span>)}
        </nav>
        <div className="flex w-full items-center gap-2 sm:w-auto"><div className="relative flex-1 sm:flex-none"><Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search this folder" className="w-full pl-9 sm:w-56" /></div><Button variant="ghost" size="icon" onClick={() => browse(current)} aria-label="Refresh"><RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} /></Button></div>
      </div>
    </div>
    <div className="relative min-h-[420px] overflow-x-auto">
      {busy && createPortal(<div className="fixed inset-0 z-[90] grid place-items-center bg-white/65 backdrop-blur-[1px]" role="status" aria-live="polite">
        <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 font-medium text-slate-700 shadow-lg"><LoaderCircle className="h-5 w-5 animate-spin text-panel-600" />Loading files…</div>
      </div>, document.body)}
      <table className="w-full select-none text-left text-sm"><thead className="border-b bg-slate-50/70 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-5 py-3 font-semibold">Name</th><th className="hidden px-4 py-3 font-semibold sm:table-cell">Size</th><th className="hidden px-4 py-3 font-semibold lg:table-cell">Permissions</th><th className="hidden px-4 py-3 font-semibold md:table-cell">Modified</th></tr></thead>
        <tbody className="divide-y divide-slate-100">{current && <tr className="cursor-default hover:bg-panel-50/40" onDoubleClick={() => browse(crumbs.slice(0, -1).join("/"))}><td className="px-5 py-3" colSpan={4}><div className="flex items-center gap-3 font-medium"><Folder className="h-5 w-5 fill-slate-100 text-slate-400" />..</div></td></tr>}
          {items.map((item) => <tr key={item.name} onClick={() => setSelected(item.name)} onDoubleClick={() => void open(item)} onContextMenu={(event) => showMenu(event, item)} className={`cursor-default ${selected === item.name ? "bg-panel-50 ring-1 ring-inset ring-panel-200" : "hover:bg-panel-50/40"}`}><td className="px-5 py-3"><div className="flex max-w-md items-center gap-3 font-medium text-ink"><span className="rounded-lg bg-slate-100 p-2">{item.type === "directory" ? <Folder className="h-5 w-5 fill-amber-100 text-amber-500" /> : <FileCode2 className="h-5 w-5 text-panel-600" />}</span><span className="truncate">{item.name}</span></div></td><td className="hidden px-4 py-3 text-slate-500 sm:table-cell">{item.type === "directory" ? "—" : formatSize(item.size)}</td><td className="hidden px-4 py-3 font-mono text-xs text-slate-500 lg:table-cell">{item.permissions ?? "—"}</td><td className="hidden px-4 py-3 text-slate-500 md:table-cell">{formatModified(item.modified)}</td></tr>)}
        </tbody></table>
      {!items.length && <div className="flex flex-col items-center py-20 text-slate-400"><File className="mb-3 h-10 w-10" /><p className="font-medium">{search ? "No matching files" : "This folder is empty"}</p></div>}
    </div>
    {menu && createPortal(<div ref={placeMenu} style={{ left: menu.x, top: menu.y, visibility: "hidden" }} className="fixed z-[85] w-52 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-sm shadow-2xl" onClick={(e) => e.stopPropagation()}>
      <MenuButton icon={<FolderOpen />} label="Open" onClick={() => void open(menu.item)} />
      {menu.item.type === "file" && <><MenuButton icon={<Pencil />} label="Edit" onClick={() => void open(menu.item)} /><MenuButton icon={<Download />} label="Download" onClick={() => void download(menu.item)} /></>}
      <div className="my-1 border-t" /><MenuButton icon={<Pencil />} label="Rename" onClick={() => { setModal({ kind: "rename", name: menu.item.name }); setMenu(null); }} />
      <MenuButton icon={<Copy />} label="Copy" onClick={() => { setClipboard({ source: [current, menu.item.name].filter(Boolean).join("/"), mode: "copy" }); setMenu(null); toast.success("Copied to clipboard"); }} />
      <MenuButton icon={<Scissors />} label="Cut" onClick={() => { setClipboard({ source: [current, menu.item.name].filter(Boolean).join("/"), mode: "cut" }); setMenu(null); toast.success("Ready to move"); }} />
      {clipboard && menu.item.type === "directory" && <MenuButton icon={<Copy />} label="Paste into folder" onClick={async () => { await request({ action: "paste", path: [current, menu.item.name].filter(Boolean).join("/"), source: clipboard.source, mode: clipboard.mode }, "Pasted"); if (clipboard.mode === "cut") setClipboard(null); setMenu(null); }} />}
      {menu.item.type === "file" && <MenuButton icon={<Copy />} label="Duplicate" onClick={() => void itemAction("duplicate", menu.item, {}, "Duplicated")} />}
      <MenuButton icon={<Archive />} label="Compress to ZIP" onClick={() => { setModal({ kind: "compress", name: menu.item.name, value: `${menu.item.name}.zip` }); setMenu(null); }} />
      {menu.item.type === "file" && menu.item.name.toLowerCase().endsWith(".zip") && <MenuButton icon={<Archive />} label="Extract here" onClick={() => void itemAction("extract", menu.item, {}, "Archive extracted")} />}
      <MenuButton icon={<KeyRound />} label="Change permissions" onClick={() => { setModal({ kind: "permissions", name: menu.item.name, value: menu.item.permissions ?? "0755" }); setMenu(null); }} />
      <div className="my-1 border-t" /><MenuButton danger icon={<Trash2 />} label="Delete" onClick={() => { setMenu(null); void remove(menu.item); }} />
    </div>, document.body)}
    {modal && createPortal(<div className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-slate-950/40 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(null); }}><form className={`my-auto w-full max-h-[calc(100vh-2rem)] overflow-hidden rounded-2xl bg-white p-5 shadow-2xl ${modal.kind === "edit" ? "max-w-6xl" : "max-w-md"}`} onSubmit={async (e) => { e.preventDefault(); const form = new FormData(e.currentTarget); const name = String(form.get("name") ?? modal.name ?? ""); const content = String(form.get("content") ?? ""); let completed = true; if (modal.kind === "rename") await request({ action: "rename", path: current, name: modal.name, newName: name }, "Renamed"); else if (modal.kind === "edit") completed = Boolean(await request({ action: "save-file", path: current, name: modal.name, content }, "File saved")); else if (modal.kind === "permissions") await request({ action: "chmod", path: current, name: modal.name, mode: name }, "Permissions changed"); else if (modal.kind === "compress") await request({ action: "compress", path: current, name: modal.name, archiveName: name }, "Archive created"); else await request({ action: modal.kind === "file" ? "new-file" : "new-folder", path: current, name }, `${modal.kind === "file" ? "File" : "Folder"} created`); if (completed) setModal(null); }}>
      <div className="mb-4 flex items-center justify-between gap-4"><div><h3 className="text-lg font-bold capitalize">{modal.kind === "edit" ? `Edit ${modal.name}` : `${modal.kind} ${modal.kind === "rename" ? modal.name : ""}`}</h3>{modal.kind === "edit" && <p className={`mt-1 flex items-center gap-2 text-xs font-medium ${modal.content === modal.originalContent ? "text-emerald-600" : "text-amber-600"}`}>{busy ? <><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Saving…</> : modal.content === modal.originalContent ? <><span className="h-2 w-2 rounded-full bg-emerald-500" />Saved</> : <><span className="h-2 w-2 rounded-full bg-amber-500" />Unsaved changes</>}</p>}</div><button type="button" onClick={() => setModal(null)}><X className="h-5 w-5" /></button></div>
      {modal.kind === "edit" ? <><input type="hidden" name="content" value={modal.content ?? ""} /><CodeEditor value={modal.content ?? ""} onChange={(content) => setModal((currentModal) => currentModal?.kind === "edit" ? { ...currentModal, content } : currentModal)} language={languageForFile(modal.name ?? "")} height="60vh" ariaLabel={`Edit ${modal.name}`} /></> : <><Input name="name" defaultValue={modal.kind === "rename" ? modal.name : modal.value ?? ""} placeholder={modal.kind === "permissions" ? "0755" : modal.kind === "folder" ? "Folder name" : "File name"} pattern={modal.kind === "permissions" ? "[0-7]{3,4}" : undefined} autoFocus required />{modal.kind === "permissions" && <p className="mt-2 text-xs text-slate-500">Use an octal mode such as 0644 for files or 0755 for folders.</p>}</>}
      <div className="mt-5 flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setModal(null)}>Cancel</Button><Button disabled={busy || (modal.kind === "edit" && modal.content === modal.originalContent)}>{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{modal.kind === "edit" ? "Save changes" : modal.kind === "rename" ? "Rename" : modal.kind === "permissions" ? "Apply" : modal.kind === "compress" ? "Compress" : "Create"}</Button></div>
    </form></div>, document.body)}
    
    {confirmAction && (
      <ConfirmDialog
        title={confirmAction.title}
        message={confirmAction.message}
        onConfirm={confirmAction.onConfirm}
        onCancel={() => setConfirmAction(null)}
      />
    )}
  </section>;
}

function MenuButton({ icon, label, onClick, danger = false }: { icon: React.ReactElement<{ className?: string }>; label: string; onClick: () => void; danger?: boolean }) {
  return <button type="button" onClick={onClick} className={`flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-slate-100 ${danger ? "text-red-600" : "text-slate-700"}`}>{icon && <span className="[&>svg]:h-4 [&>svg]:w-4">{icon}</span>}{label}</button>;
}
