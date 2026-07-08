import { LoaderCircle } from "lucide-react";

export default function Loading() {
  return <div className="fixed inset-0 z-[100] grid place-items-center bg-slate-50/65 backdrop-blur-[2px]" role="status" aria-label="Loading page">
    <div className="flex items-center gap-3 rounded-2xl border border-white/80 bg-white/95 px-5 py-4 font-semibold text-slate-700 shadow-2xl">
      <LoaderCircle className="h-6 w-6 animate-spin text-panel-600" />
      Loading…
    </div>
  </div>;
}
