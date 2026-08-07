"use client";

import { useState } from "react";
import { Laptop, LoaderCircle, LogOut } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { PublicSession } from "@/server/auth/session";

export function SessionManager({
  initialSessions,
}: {
  initialSessions: PublicSession[];
}) {
  const [sessions, setSessions] = useState(initialSessions);
  const [busy, setBusy] = useState<string | null>(null);
  async function revoke(id?: string) {
    setBusy(id ?? "all");
    try {
      const response = await fetch("/api/profile/sessions", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(id ? { id } : { all: true }),
      });
      const result = await response.json();
      if (!result.success)
        throw new Error(
          result.error?.message || "Sessions could not be revoked.",
        );
      setSessions(result.data);
      toast.success(id ? "Session revoked" : "Other sessions revoked");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Sessions could not be revoked.",
      );
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="overflow-hidden rounded-2xl border border-white/40 bg-white/60 shadow-card backdrop-blur-md">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200/50 bg-slate-50/40 px-5 py-4 sm:px-6">
        <div>
          <h3 className="flex items-center gap-2 font-bold">
            <Laptop className="h-4 w-4 text-panel-600" /> Active sessions
          </h3>
          <p className="mt-0.5 text-sm text-slate-500">
            Devices currently signed in to your account.
          </p>
        </div>
        {sessions.some((item) => !item.current) && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => revoke()}
          >
            <LogOut className="h-4 w-4" /> Revoke others
          </Button>
        )}
      </div>
      <div className="divide-y divide-slate-100">
        {sessions.map((item) => (
          <div
            key={item.id}
            className="flex items-center justify-between gap-4 px-5 py-4 text-sm sm:px-6"
          >
            <div className="min-w-0">
              <p className="truncate font-medium text-slate-700">
                {item.userAgent || "Unknown device"}{" "}
                {item.current && (
                  <span className="text-panel-600">(current)</span>
                )}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {item.address || "Unknown address"} · Last active{" "}
                {new Date(item.lastSeenAt).toLocaleString()}
              </p>
            </div>
            {!item.current && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => revoke(item.id)}
              >
                {busy === item.id ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  "Revoke"
                )}
              </Button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
