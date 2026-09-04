"use client";

import { useState } from "react";
import {
  CloudDownload,
  CloudUpload,
  LoaderCircle,
  Save,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { BackupSnapshot } from "./backups-manager";

export type OffsiteBackupData = {
  destination: {
    enabled: boolean;
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    accessKeyId: string;
    hasSecret: boolean;
    forcePathStyle: boolean;
  } | null;
  items: Array<{ id: string; bytes: number; modifiedAt: string }>;
};

function size(bytes: number) {
  return `${Math.max(0, bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function OffsiteBackups({
  domain,
  initialData,
  snapshots,
  canWrite,
  apiBase = "",
}: {
  domain: string;
  initialData: OffsiteBackupData;
  snapshots: BackupSnapshot[];
  canWrite: boolean;
  apiBase?: string;
}) {
  const initial = initialData.destination;
  const [form, setForm] = useState({
    enabled: initial?.enabled ?? false,
    endpoint: initial?.endpoint ?? "",
    region: initial?.region ?? "auto",
    bucket: initial?.bucket ?? "",
    prefix: initial?.prefix ?? "panelavo",
    accessKeyId: initial?.accessKeyId ?? "",
    secretAccessKey: "",
    forcePathStyle: initial?.forcePathStyle ?? false,
  });
  const [items, setItems] = useState(initialData.items);
  const [configured, setConfigured] = useState(Boolean(initial));
  const [busy, setBusy] = useState<string | null>(null);

  async function request(method: string, body?: Record<string, unknown>) {
    const response = await fetch(
      `${apiBase}/api/sites/${encodeURIComponent(domain)}/backups/offsite`,
      {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    const result = await response.json();
    if (!result.success)
      throw new Error(
        result.error?.message || "The off-site operation failed.",
      );
    return result.data as OffsiteBackupData;
  }

  async function save() {
    setBusy("save");
    try {
      const result = await request("PUT", form);
      setItems(result.items ?? []);
      setConfigured(true);
      setForm((current) => ({ ...current, secretAccessKey: "" }));
      toast.success("Off-site destination verified and saved");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The destination could not be saved.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function act(action: "upload" | "restore" | "delete", id: string) {
    if (
      (action === "restore" || action === "delete") &&
      !window.confirm(
        action === "restore"
          ? "Download this snapshot and restore it over the live site? This is an in-place overlay and cannot be undone."
          : "Permanently delete this off-site copy?",
      )
    )
      return;
    setBusy(`${action}:${id}`);
    try {
      const result = await request("POST", { action, id });
      setItems(result.items ?? []);
      toast.success(
        action === "upload"
          ? "Backup copied off-site"
          : action === "restore"
            ? "Off-site backup restored"
            : "Off-site copy deleted",
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The off-site operation failed.",
      );
    } finally {
      setBusy(null);
    }
  }

  const input =
    (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
      setForm((current) => ({ ...current, [key]: event.target.value }));

  return (
    <section className="overflow-hidden rounded-2xl border border-white/40 bg-white/60 shadow-card backdrop-blur-md">
      <div className="flex gap-3 border-b border-slate-200/50 bg-slate-50/40 px-5 py-4 sm:px-6">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-panel-50 text-panel-600">
          <CloudUpload className="h-5 w-5" />
        </span>
        <div>
          <h3 className="font-bold">S3-compatible off-site copy</h3>
          <p className="mt-0.5 text-sm text-slate-500">
            Stream complete snapshot bundles to S3, Backblaze B2, Cloudflare R2,
            or a compatible service.
          </p>
        </div>
      </div>
      <div className="grid gap-4 px-5 py-5 sm:grid-cols-2 sm:px-6 lg:grid-cols-3">
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input
            type="checkbox"
            checked={form.enabled}
            disabled={!canWrite || Boolean(busy)}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                enabled: event.target.checked,
              }))
            }
          />
          Copy scheduled backups off-site
        </label>
        <div>
          <Label>HTTPS endpoint</Label>
          <Input
            value={form.endpoint}
            onChange={input("endpoint")}
            disabled={!canWrite || Boolean(busy)}
            placeholder="https://s3.example.com"
          />
        </div>
        <div>
          <Label>Region</Label>
          <Input
            value={form.region}
            onChange={input("region")}
            disabled={!canWrite || Boolean(busy)}
          />
        </div>
        <div>
          <Label>Bucket</Label>
          <Input
            value={form.bucket}
            onChange={input("bucket")}
            disabled={!canWrite || Boolean(busy)}
          />
        </div>
        <div>
          <Label>Object prefix</Label>
          <Input
            value={form.prefix}
            onChange={input("prefix")}
            disabled={!canWrite || Boolean(busy)}
          />
        </div>
        <div>
          <Label>Access key ID</Label>
          <Input
            value={form.accessKeyId}
            onChange={input("accessKeyId")}
            disabled={!canWrite || Boolean(busy)}
          />
        </div>
        <div>
          <Label>Secret access key</Label>
          <Input
            type="password"
            value={form.secretAccessKey}
            onChange={input("secretAccessKey")}
            disabled={!canWrite || Boolean(busy)}
            placeholder={
              configured ? "Leave blank to keep existing" : "Required"
            }
          />
        </div>
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input
            type="checkbox"
            checked={form.forcePathStyle}
            disabled={!canWrite || Boolean(busy)}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                forcePathStyle: event.target.checked,
              }))
            }
          />
          Force path-style URLs
        </label>
        {canWrite ? (
          <div className="flex items-end">
            <Button disabled={Boolean(busy)} onClick={() => void save()}>
              {busy === "save" ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Verify and save
            </Button>
          </div>
        ) : null}
      </div>
      {configured ? (
        <div className="border-t border-slate-100 px-5 py-5 sm:px-6">
          <h4 className="text-sm font-bold">Remote copies</h4>
          <div className="mt-3 space-y-2">
            {items.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-100 bg-white/60 px-4 py-3 text-sm"
              >
                <span>
                  <b>{item.id}</b>{" "}
                  <span className="text-xs text-slate-400">
                    {size(item.bytes)}
                  </span>
                </span>
                {canWrite ? (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(busy)}
                      onClick={() => void act("restore", item.id)}
                    >
                      {busy === `restore:${item.id}` ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <CloudDownload className="h-4 w-4" />
                      )}
                      Restore
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(busy)}
                      onClick={() => void act("delete", item.id)}
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
            {!items.length ? (
              <p className="text-sm text-slate-400">
                No remote copies found under this site prefix.
              </p>
            ) : null}
          </div>
          {canWrite && snapshots.length ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {snapshots.slice(0, 5).map((snapshot) => (
                <Button
                  key={snapshot.id}
                  size="sm"
                  variant="outline"
                  disabled={Boolean(busy)}
                  onClick={() => void act("upload", snapshot.id)}
                >
                  {busy === `upload:${snapshot.id}` ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <CloudUpload className="h-4 w-4" />
                  )}
                  Copy {snapshot.id}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
