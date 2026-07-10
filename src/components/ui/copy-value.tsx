"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/**
 * Click-to-copy wrapper for a displayed value. Shows a copy affordance on
 * hover and flips to a check mark for a moment after copying.
 */
export function CopyValue({
  value,
  children,
  className,
}: {
  value: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard API can be unavailable (http, permissions); fall back.
      const area = document.createElement("textarea");
      area.value = value;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title="Click to copy"
      className={cn(
        "group inline-flex max-w-full items-center gap-1.5 rounded-md text-left transition hover:bg-panel-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-panel-500",
        className,
      )}
    >
      <span className="min-w-0 break-words">{children}</span>
      {copied ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
      ) : (
        <Copy className="h-3.5 w-3.5 shrink-0 text-slate-300 transition group-hover:text-panel-600" />
      )}
    </button>
  );
}
