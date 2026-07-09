import type { Metadata } from "next";
import { AlertCircle, Clock, Globe2, UserRound } from "lucide-react";
import { Brand } from "@/components/brand";
import { InviteForm } from "@/components/auth/invite-form";
import { verifyInviteToken } from "@/server/auth/invites";

export const metadata: Metadata = { title: "Account invitation" };
export const dynamic = "force-dynamic";

const roleLabels: Record<string, string> = {
  "super-admin": "Super admin — full access",
  manager: "Manager — all websites",
  admin: "Admin — own + assigned websites",
  user: "User — assigned websites only",
};

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invite = verifyInviteToken(decodeURIComponent(token));

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#fbfcfe] px-4 py-10 sm:px-6">
      <div className="w-full max-w-[440px]">
        <div className="mb-10">
          <Brand />
        </div>
        {!invite ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-card">
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-red-50 text-red-600">
              <AlertCircle className="h-6 w-6" />
            </span>
            <h1 className="mt-5 text-xl font-bold text-ink">Invitation not valid</h1>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              This invitation link is invalid or has expired (links are valid for 24 hours).
              Ask your administrator to send a new one.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
            <div className="border-b border-slate-100 bg-slate-50/60 p-6">
              <p className="text-sm font-semibold text-panel-600">YOU&apos;RE INVITED</p>
              <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink">
                Finish setting up your account
              </h1>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                {invite.invitedBy} invited you to this server panel. Choose a password to
                activate the account below.
              </p>
            </div>
            <div className="space-y-4 p-6">
              <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/60 p-4 text-sm">
                <p className="flex items-center gap-2 font-semibold text-ink">
                  <UserRound className="h-4 w-4 text-panel-600" />
                  {invite.firstName} {invite.lastName}
                  <span className="font-normal text-slate-400">· {invite.username}</span>
                </p>
                <p className="text-slate-500">{invite.email}</p>
                <p className="flex items-center gap-2 text-slate-600">
                  <Globe2 className="h-4 w-4 text-slate-400" />
                  {roleLabels[invite.role] ?? invite.role}
                  {invite.sites.length > 0 && ` · ${invite.sites.join(", ")}`}
                </p>
                <p className="flex items-center gap-2 text-xs text-slate-400">
                  <Clock className="h-3.5 w-3.5" />
                  Link expires {new Date(invite.exp * 1000).toLocaleString()}
                </p>
              </div>
              <InviteForm token={decodeURIComponent(token)} username={invite.username} />
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
