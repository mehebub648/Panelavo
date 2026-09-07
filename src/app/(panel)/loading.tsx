export default function LoadingPanelPage() {
  return (
    <div
      role="status"
      className="mx-auto max-w-7xl animate-pulse space-y-4 p-6"
    >
      <p className="text-sm text-slate-500">Loading page...</p>
      <div className="h-24 rounded-2xl bg-slate-100" />
      <div className="h-56 rounded-2xl bg-slate-100" />
    </div>
  );
}
