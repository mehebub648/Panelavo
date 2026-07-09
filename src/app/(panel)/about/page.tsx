import type { Metadata } from "next";
import { Boxes, GitBranch, ServerCog, ShieldCheck } from "lucide-react";

export const metadata: Metadata = { title: "About" };

const notices = [
  {
    icon: ServerCog,
    title: "Built to run on your server",
    body: "panelavo is installed from this repository and runs alongside CloudPanel on the server you control.",
  },
  {
    icon: ShieldCheck,
    title: "CloudPanel stays authoritative",
    body: "Accounts, passwords, MFA, roles, site assignments, and runtime operations remain managed by CloudPanel.",
  },
  {
    icon: GitBranch,
    title: "Public project",
    body: "The project is intended for public cloning, installation, and self-hosted operation.",
  },
];

export default function AboutPage() {
  return (
    <div className="w-full space-y-5">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-ink">
          About panelavo
        </h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">
          panelavo is a self-hosted companion interface for CloudPanel. It adds
          a focused website-management workspace while keeping CloudPanel as the
          source of truth.
        </p>
      </div>

      <section className="rounded-2xl border border-white/60 bg-white/70 p-5 shadow-card backdrop-blur-md sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-panel-600 text-white">
            <Boxes className="h-6 w-6" />
          </span>
          <div>
            <h3 className="text-lg font-bold text-ink">panelavo</h3>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">
              This software works over CloudPanel, but it is not affiliated
              with, endorsed by, or sponsored by CloudPanel.
            </p>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {notices.map(({ icon: Icon, title, body }) => (
          <article
            key={title}
            className="rounded-2xl border border-white/60 bg-white/70 p-5 shadow-card backdrop-blur-md"
          >
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-panel-50 text-panel-600">
              <Icon className="h-5 w-5" />
            </span>
            <h3 className="mt-4 font-bold text-ink">{title}</h3>
            <p className="mt-2 text-sm leading-6 text-slate-500">{body}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
