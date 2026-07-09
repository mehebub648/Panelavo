import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  Globe2,
  ServerCog,
  ShieldCheck,
} from "lucide-react";
import { Brand } from "@/components/brand";
import { LoginForm } from "@/components/auth/login-form";
import { getSession } from "@/server/auth/session";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const session = await getSession({ allowPending: true });
  const reason = (await searchParams).reason;
  if (session?.record.user) redirect("/sites");
  return (
    <main className="min-h-screen bg-white lg:grid lg:grid-cols-[1.04fr_.96fr]">
      <section className="relative hidden overflow-hidden bg-[#0d3e60] px-16 py-12 text-white lg:flex lg:flex-col">
        <div
          className="absolute inset-0 opacity-30"
          style={{
            backgroundImage:
              "radial-gradient(circle at 20% 30%, #50b7df 0, transparent 26%), radial-gradient(circle at 90% 80%, #167cae 0, transparent 30%)",
          }}
        />
        <div className="absolute -bottom-48 -right-32 h-[520px] w-[520px] rounded-full border border-white/10" />
        <div className="absolute -bottom-28 -right-10 h-[350px] w-[350px] rounded-full border border-white/10" />
        <div className="relative">
          <Brand inverse />
        </div>
        <div className="relative my-auto max-w-xl pb-16">
          <p className="mb-5 text-sm font-bold uppercase tracking-[.2em] text-cyan-300">
            panelavo for CloudPanel servers
          </p>
          <h1 className="text-5xl font-bold leading-[1.08] tracking-[-.04em]">
            Your CloudPanel server.
            <br />
            Cleaner to manage.
          </h1>
          <p className="mt-6 max-w-lg text-lg leading-8 text-slate-200">
            panelavo is a self-hosted companion interface for CloudPanel. It
            keeps CloudPanel as the source of truth while giving day-to-day
            website work a focused workspace.
          </p>
          <div className="mt-12 grid grid-cols-2 gap-4">
            {[
              { icon: Globe2, label: "Sites at a glance" },
              { icon: ShieldCheck, label: "CloudPanel permissions" },
              { icon: ServerCog, label: "Self-hosted install" },
              { icon: CheckCircle2, label: "No duplicated accounts" },
            ].map(({ icon: Icon, label }) => (
              <div
                key={label}
                className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[.07] p-4 text-sm font-medium text-slate-100 backdrop-blur"
              >
                <Icon className="h-4 w-4 text-cyan-300" />
                {label}
              </div>
            ))}
          </div>
        </div>
        <p className="relative text-xs text-slate-400">
          panelavo is not affiliated with, endorsed by, or sponsored by
          CloudPanel.
        </p>
      </section>
      <section className="flex min-h-screen items-center justify-center bg-[#fbfcfe] px-6 py-12">
        <div className="w-full max-w-[430px]">
          <div className="mb-12 lg:hidden">
            <Brand />
          </div>
          <div className="mb-8">
            <p className="mb-2 text-sm font-semibold text-panel-600">
              WELCOME TO PANELAVO
            </p>
            <h2 className="text-3xl font-bold tracking-tight text-ink">
              Sign in with CloudPanel
            </h2>
            <p className="mt-3 text-sm leading-6 text-slate-500">
              Use your existing CloudPanel account. panelavo does not create a
              separate user database.
            </p>
          </div>
          {reason === "session-expired" && (
            <div className="mb-5 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-800">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              Your session expired. Sign in to continue.
            </div>
          )}
          <LoginForm
            initialTwoFactor={Boolean(session?.record.twoFactorPending)}
          />
        </div>
      </section>
    </main>
  );
}
