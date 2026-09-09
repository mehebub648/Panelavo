"use client";
import React, { useState } from "react";
import { SiteSectionManager } from "./site-section-manager";
import { Button } from "@/components/ui/button";

export function LazySiteSection({
  domain,
  section,
  title,
  apiBase = "",
  canWrite,
}: {
  domain: string;
  section: "cron-jobs" | "logs";
  title: string;
  apiBase?: string;
  canWrite: boolean;
}) {
  const [data, setData] = useState<Record<string, unknown>>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      const result = await fetch(
        `${apiBase}/api/sites/${encodeURIComponent(domain)}/sections/${section}`,
      ).then((response) => response.json());
      if (!result.success)
        throw new Error(
          result.error?.message || `${title} could not be loaded.`,
        );
      setData(result.data);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : `${title} could not be loaded.`,
      );
    } finally {
      setLoading(false);
    }
  }
  if (!canWrite) return null;
  return (
    <details
      id={section === "logs" ? "application-logs" : "scheduled-jobs"}
      className="rounded-2xl border bg-white p-5"
      onToggle={(event) => {
        if (event.currentTarget.open && !data && !loading && !error)
          void load();
      }}
    >
      <summary className="cursor-pointer font-semibold">{title}</summary>
      <div className="mt-4">
        {loading && (
          <p role="status" className="text-sm text-slate-500">
            Loading {title.toLowerCase()}…
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}{" "}
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </p>
        )}
        {data && (
          <SiteSectionManager
            domain={domain}
            section={section}
            initialData={data}
            apiBase={apiBase}
          />
        )}
      </div>
    </details>
  );
}
