import Link from "next/link";
import { CheckCircle2, Globe2, Pencil, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

type Category = { id: string; label: string; start: number; end: number };

export function PanelSettingsForm({
  baseDomain,
  serverIp,
  wildcardDomain,
  isDefault,
  pointed,
  categories,
}: {
  baseDomain: string;
  serverIp: string;
  wildcardDomain: string;
  isDefault: boolean;
  pointed: boolean;
  categories: Category[];
}) {
  const panelAddress = `panel.${serverIp}.${baseDomain}`;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-ink">Panel settings</h2>
        <p className="mt-1 text-sm text-slate-500">
          Base domain and site id ranges used when creating websites.
        </p>
      </div>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/60 px-5 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-panel-50 text-panel-600">
              <Globe2 className="h-5 w-5" />
            </span>
            <h3 className="font-bold">Base domain</h3>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href="/setup?reconfigure=1">
              <Pencil className="h-4 w-4" /> Change
            </Link>
          </Button>
        </div>

        <div className="space-y-4 p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xl font-semibold text-ink">{baseDomain}</span>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                isDefault
                  ? "bg-panel-50 text-panel-700"
                  : "bg-slate-100 text-slate-600"
              }`}
            >
              {isDefault ? "Default domain" : "Custom domain"}
            </span>
          </div>

          {pointed ? (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700">
              <CheckCircle2 className="h-4 w-4" /> Configured — wildcard resolves to this server
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-700">
              <TriangleAlert className="h-4 w-4" /> Wildcard {wildcardDomain} is not resolving here
            </span>
          )}

          <dl className="grid gap-3 rounded-xl bg-slate-50 px-4 py-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-500">Panel address</dt>
              <dd className="mt-0.5 break-all font-mono text-slate-700">{panelAddress}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Wildcard DNS</dt>
              <dd className="mt-0.5 break-all font-mono text-slate-700">{wildcardDomain}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
        <div className="border-b border-slate-100 bg-slate-50/60 px-5 py-4 sm:px-6">
          <h3 className="font-bold">Site id &amp; port ranges</h3>
          <p className="text-sm text-slate-500">
            Each website reserves one id from its category; the id is also the
            application port and the site user name (site-&lt;id&gt;).
          </p>
        </div>
        <div className="divide-y divide-slate-100 text-sm">
          {categories.map((category) => (
            <div key={category.id} className="flex items-center justify-between px-5 py-3 sm:px-6">
              <span className="font-medium text-slate-700">{category.label}</span>
              <span className="font-mono text-slate-500">
                {category.start}–{category.end}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
