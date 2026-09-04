"use client";

import React, { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";

export function UpdateMaintenanceGuard({
  initialRunning,
}: {
  initialRunning: boolean;
}) {
  const [running, setRunning] = useState(initialRunning);
  const wasRunning = useRef(initialRunning);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    function schedule() {
      if (active && !document.hidden)
        timer = setTimeout(
          () => void poll(),
          wasRunning.current ? 2_000 : 60_000,
        );
    }
    async function poll() {
      if (!active || document.hidden || request) return;
      clearTimeout(timer);
      const controller = new AbortController();
      request = controller;
      try {
        const response = await fetch("/api/updates/status", {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = (await response.json()) as {
          success?: boolean;
          data?: { running?: boolean };
        };
        if (
          !active ||
          controller.signal.aborted ||
          !response.ok ||
          !body.success
        )
          return;
        const next = body.data?.running === true;
        if (wasRunning.current && !next) {
          active = false;
          window.location.reload();
          return;
        }
        wasRunning.current ||= next;
        setRunning(next);
      } catch {
        // Keep the panel locked if the application briefly reloads mid-update.
      } finally {
        request = undefined;
        if (active && controller.signal.aborted && !document.hidden)
          void poll();
        else schedule();
      }
    }
    function visibilityChanged() {
      clearTimeout(timer);
      if (document.hidden) request?.abort();
      else void poll();
    }
    document.addEventListener("visibilitychange", visibilityChanged);
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      request?.abort();
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, []);

  if (!running) return null;
  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-slate-950/70 p-6 backdrop-blur-sm"
      role="status"
      aria-live="polite"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-2xl">
        <LoaderCircle className="mx-auto h-10 w-10 animate-spin text-panel-600" />
        <h2 className="mt-5 text-xl font-bold text-slate-900">
          Panelavo is updating
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          The panel is temporarily locked while the update is staged and
          deployed. This page will reload automatically when it is ready.
        </p>
      </div>
    </div>
  );
}
