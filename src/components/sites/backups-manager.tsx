"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  Clock,
  Database,
  FolderOpen,
  HardDriveDownload,
  History,
  LoaderCircle,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export type BackupSnapshot = {
  id: string;
  createdAt: string;
  bytes: number;
  hasFiles: boolean;
  databases: string[];
  note?: string;
};

export type BackupsData = {
  path: string;
  relativePath?: string;
  items?: BackupSnapshot[];
  databases?: string[];
  retention?: number;
};

function formatBytes(bytes: number) {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `${dateFormatter.format(date)} UTC`;
}

export function BackupsManager({
  domain,
  initialData,
  canWrite,
}: {
  domain: string;
  initialData: BackupsData;
  canWrite: boolean;
}) {
  const [data, setData] = useState(initialData);
  const [busy, setBusy] = useState<string | false>(false);
  const [showCreate, setShowCreate] = useState(false);
  const [confirmAction, setConfirmAction] = useState<
    { title: string; message: string; variant?: "danger" | "default"; confirmText?: string; onConfirm: () => void } | null
  >(null);

  const items = data.items ?? [];
  const databases = data.databases ?? [];

  async function request(body: Record<string, unknown>, key: string, success: string) {
    if (busy) return;
    setBusy(key);
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(domain)}/sections/backups`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error?.message || "The backup operation failed.");
      if (result.data) setData(result.data as BackupsData);
      toast.success(success);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The backup operation failed.");
    } finally {
      setBusy(false);
    }
  }

  function restore(snapshot: BackupSnapshot) {
    const parts = [
      snapshot.hasFiles ? "overwrite the website files" : null,
      snapshot.databases.length
        ? `import ${snapshot.databases.length} database${snapshot.databases.length === 1 ? "" : "s"}`
        : null,
    ].filter(Boolean);
    setConfirmAction({
      title: "Restore this backup?",
      message: `This will ${parts.join(" and ")} from the snapshot taken ${formatDate(snapshot.createdAt)}. Existing files are overwritten in place and database contents are replaced. Files created after the backup are not removed. This cannot be undone — consider taking a fresh backup first.`,
      variant: "danger",
      confirmText: "Restore backup",
      onConfirm: () => {
        setConfirmAction(null);
        void request({ action: "restore", id: snapshot.id, scope: "all" }, `restore:${snapshot.id}`, "Backup restored");
      },
    });
  }

  function remove(snapshot: BackupSnapshot) {
    setConfirmAction({
      title: "Delete this backup?",
      message: `Permanently remove the snapshot from ${formatDate(snapshot.createdAt)} (${formatBytes(snapshot.bytes)})? This cannot be undone.`,
      variant: "danger",
      confirmText: "Delete backup",
      onConfirm: () => {
        setConfirmAction(null);
        void request({ action: "delete", id: snapshot.id }, `delete:${snapshot.id}`, "Backup deleted");
      },
    });
  }

  const card =
    "overflow-hidden rounded-2xl border border-white/40 bg-white/60 shadow-card backdrop-blur-md";

  return (
    <div className="space-y-5">
      <section className={card}>
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200/50 bg-slate-50/40 px-5 py-4 sm:px-6">
          <div className="flex gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-panel-50 text-panel-600">
              <Archive className="h-5 w-5" />
            </span>
            <div>
              <h3 className="font-bold">Backups</h3>
              <p className="mt-0.5 text-sm text-slate-500">
                On-demand snapshots of this website&apos;s files and databases, stored on the
                server. The most recent {data.retention ?? 10} are kept.
              </p>
            </div>
          </div>
          {canWrite && (
            <Button disabled={Boolean(busy)} onClick={() => setShowCreate(true)}>
              {busy === "create" ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Create backup
            </Button>
          )}
        </div>

        <div className="divide-y divide-slate-100">
          {items.map((snapshot) => {
            return (
              <div
                key={snapshot.id}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 transition-colors hover:bg-slate-50/50 sm:px-6"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Clock className="h-4 w-4 text-slate-400" />
                    <b className="text-sm">{formatDate(snapshot.createdAt)}</b>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">
                      {formatBytes(snapshot.bytes)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    {snapshot.hasFiles && (
                      <span className="inline-flex items-center gap-1">
                        <FolderOpen className="h-3.5 w-3.5" /> Files
                      </span>
                    )}
                    {snapshot.databases.map((name) => (
                      <span key={name} className="inline-flex items-center gap-1">
                        <Database className="h-3.5 w-3.5" /> {name}
                      </span>
                    ))}
                    {!snapshot.hasFiles && !snapshot.databases.length && <span>Empty snapshot</span>}
                  </div>
                  {snapshot.note && (
                    <p className="mt-1.5 text-xs italic text-slate-400">{snapshot.note}</p>
                  )}
                </div>
                {canWrite && (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={Boolean(busy)}
                      onClick={() => restore(snapshot)}
                    >
                      {busy === `restore:${snapshot.id}` ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <RotateCcw className="h-4 w-4" />
                      )}
                      Restore
                    </Button>
                    <button
                      type="button"
                      aria-label="Delete backup"
                      disabled={Boolean(busy)}
                      className="rounded-lg p-2 opacity-60 transition hover:bg-red-50 hover:opacity-100 disabled:opacity-30"
                      onClick={() => remove(snapshot)}
                    >
                      {busy === `delete:${snapshot.id}` ? (
                        <LoaderCircle className="h-4 w-4 animate-spin text-red-500" />
                      ) : (
                        <Trash2 className="h-4 w-4 text-red-500" />
                      )}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {!items.length && (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-slate-400">
              <History className="h-9 w-9" />
              <p className="font-medium">No backups yet</p>
              <p className="max-w-sm text-sm">
                {canWrite
                  ? "Create a snapshot before risky changes such as deploys, migrations, or dependency upgrades."
                  : "No snapshots have been created for this website."}
              </p>
            </div>
          )}
        </div>
      </section>

      <div className="flex items-start gap-3 rounded-xl border border-panel-200/60 bg-panel-50/40 p-4 text-sm text-slate-600">
        <HardDriveDownload className="mt-0.5 h-4 w-4 shrink-0 text-panel-600" />
        <p>
          Backups live in <code className="text-xs">{data.path}</code>. Download or copy them from
          the <b>Files</b> tab (browse to <code className="text-xs">backups</code>), or over SSH/SFTP
          from the <b>Terminal</b> tab for large archives. Panelavo runs synchronous, on-server
          snapshots — it does not manage off-site or scheduled backups yet, so keep an independent
          copy of anything critical.
        </p>
      </div>

      {showCreate &&
        createPortal(
          <CreateBackupModal
            databases={databases}
            busy={busy === "create"}
            onClose={() => setShowCreate(false)}
            onCreate={async (body) => {
              await request({ action: "create", ...body }, "create", "Backup created");
              setShowCreate(false);
            }}
          />,
          document.body,
        )}

      {confirmAction && (
        <ConfirmDialog
          title={confirmAction.title}
          message={confirmAction.message}
          variant={confirmAction.variant}
          confirmText={confirmAction.confirmText}
          onConfirm={confirmAction.onConfirm}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  );
}

function CreateBackupModal({
  databases,
  busy,
  onClose,
  onCreate,
}: {
  databases: string[];
  busy: boolean;
  onClose: () => void;
  onCreate: (body: { files: boolean; databases: string[]; note?: string }) => void;
}) {
  const [files, setFiles] = useState(true);
  const [selected, setSelected] = useState<string[]>(databases);
  const [note, setNote] = useState("");

  const nothingSelected = !files && !selected.length;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-slate-950/40 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Create backup"
        className="my-auto w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
          <h2 className="text-lg font-bold text-ink">Create backup</h2>
          <button type="button" aria-label="Close" onClick={onClose}>
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-4 p-6">
          <label className="flex items-center gap-3 rounded-xl border border-slate-200 p-4 text-sm font-medium">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={files}
              onChange={(event) => setFiles(event.target.checked)}
            />
            <FolderOpen className="h-4 w-4 text-slate-400" />
            Website files (application root)
          </label>

          <div className="rounded-xl border border-slate-200 p-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Database className="h-4 w-4 text-slate-400" /> Databases
            </p>
            {databases.length ? (
              <div className="mt-3 space-y-2">
                {databases.map((name) => (
                  <label key={name} className="flex items-center gap-3 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={selected.includes(name)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, name]
                            : current.filter((item) => item !== name),
                        )
                      }
                    />
                    <code className="text-xs">{name}</code>
                  </label>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-xs text-slate-400">This website has no databases.</p>
            )}
          </div>

          <div>
            <Label htmlFor="backup-note">Note (optional)</Label>
            <Input
              id="backup-note"
              value={note}
              maxLength={200}
              placeholder="e.g. before v2 migration"
              onChange={(event) => setNote(event.target.value)}
              className="mt-1.5"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 px-6 py-4">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || nothingSelected}
            onClick={() => onCreate({ files, databases: selected, note: note.trim() || undefined })}
          >
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
            Create backup
          </Button>
        </div>
      </div>
    </div>
  );
}
