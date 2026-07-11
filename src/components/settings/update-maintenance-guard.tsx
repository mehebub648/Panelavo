"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";

export function UpdateMaintenanceGuard({ initialRunning }: { initialRunning: boolean }) {
  const [running, setRunning] = useState(initialRunning);
  const wasRunning = useRef(initialRunning);

  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const response = await fetch("/api/updates/status", { cache: "no-store" });
        const body = await response.json() as { success?: boolean; data?: { running?: boolean } };
        if (!active || !body.success) return;
        const next = body.data?.running === true;
        if (wasRunning.current && !next) {
          window.location.reload();
          return;
        }
        wasRunning.current ||= next;
        setRunning(next);
      } catch {
        // Keep the panel locked if the application briefly reloads mid-update.
      }
    }
    const timer = window.setInterval(() => void poll(), 2000);
    void poll();
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  if (!running) return null;
  return <div className="fixed inset-0 z-[100] grid place-items-center bg-slate-950/70 p-6 backdrop-blur-sm" role="status" aria-live="polite">
    <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-2xl">
      <LoaderCircle className="mx-auto h-10 w-10 animate-spin text-panel-600" />
      <h2 className="mt-5 text-xl font-bold text-slate-900">Panelavo is updating</h2>
      <p className="mt-2 text-sm leading-6 text-slate-500">The panel is temporarily locked while the update is staged and deployed. This page will reload automatically when it is ready.</p>
    </div>
  </div>;
}
