"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { LoaderCircle } from "lucide-react";

export function NavigationLoading() {
  const pathname = usePathname();
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLoading(false);
    if (timer.current) clearTimeout(timer.current);
  }, [pathname]);

  useEffect(() => {
    function start() {
      setLoading(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setLoading(false), 15_000);
    }
    function click(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest("a");
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      if (destination.pathname === window.location.pathname && destination.search === window.location.search) return;
      start();
    }
    document.addEventListener("click", click, true);
    window.addEventListener("popstate", start);
    return () => {
      document.removeEventListener("click", click, true);
      window.removeEventListener("popstate", start);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  if (!loading) return null;
  return <div className="fixed inset-0 z-[100] grid place-items-center bg-slate-50/65 backdrop-blur-[2px]" role="status" aria-live="polite" aria-label="Loading page">
    <div className="flex items-center gap-3 rounded-2xl border border-white/80 bg-white/95 px-5 py-4 font-semibold text-slate-700 shadow-2xl">
      <LoaderCircle className="h-6 w-6 animate-spin text-panel-600" />
      Loading…
    </div>
  </div>;
}
