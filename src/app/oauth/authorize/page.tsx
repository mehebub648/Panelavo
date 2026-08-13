import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AlertTriangle, ArrowRight, Bot, ShieldCheck } from "lucide-react";
import { Brand } from "@/components/brand";
import { requireUser } from "@/server/auth/require-user";
import { AppError } from "@/server/cloudpanel/errors";
import {
  createMcpConsent,
  mcpAuthorizationErrorRedirect,
  mcpAuthorizeReturnTo,
  validateMcpAuthorizationRequest,
} from "@/server/mcp/oauth";
import { getMcpPublicUrlsFromHeaders } from "@/server/mcp/public-url";

export const metadata: Metadata = { title: "Approve AI connection" };

type SearchValues = Record<string, string | string[] | undefined>;

function toSearchParams(values: SearchValues) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else if (value !== undefined) {
      params.append(key, value);
    }
  }
  return params;
}

function AuthorizationProblem({ message }: { message: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6 py-12">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <Brand />
        <div className="mt-8 flex h-12 w-12 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <h1 className="mt-5 text-2xl font-bold tracking-tight text-slate-950">
          This connection cannot continue
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">{message}</p>
        <a
          href="/ai-access"
          className="hover:text-panel-800 mt-7 inline-flex items-center gap-2 text-sm font-semibold text-panel-700"
        >
          Back to AI access <ArrowRight className="h-4 w-4" />
        </a>
      </div>
    </main>
  );
}

export default async function McpAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<SearchValues>;
}) {
  const params = toSearchParams(await searchParams);
  let authorization;
  try {
    const urls = getMcpPublicUrlsFromHeaders(new Headers(await headers()));
    authorization = await validateMcpAuthorizationRequest(params, urls);
  } catch (error) {
    const errorRedirect = mcpAuthorizationErrorRedirect(error);
    if (errorRedirect) redirect(errorRedirect);
    return (
      <AuthorizationProblem
        message={
          error instanceof Error
            ? error.message
            : "The requesting app sent an invalid authorization request."
        }
      />
    );
  }

  let session;
  try {
    session = await requireUser();
  } catch (error) {
    if (error instanceof AppError && error.status === 401) {
      const returnTo = mcpAuthorizeReturnTo(params);
      if (!returnTo)
        return (
          <AuthorizationProblem message="The authorization request is too large to continue safely." />
        );
      redirect(`/login?${new URLSearchParams({ returnTo }).toString()}`);
    }
    return (
      <AuthorizationProblem
        message={
          error instanceof Error
            ? error.message
            : "Panelavo could not verify the current account."
        }
      />
    );
  }

  const consent = await createMcpConsent(authorization, session.user);
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6 py-12">
      <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-8 shadow-sm sm:p-10">
        <Brand />
        <div className="mt-9 flex items-start gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-panel-50 text-panel-700">
            <Bot className="h-6 w-6" />
          </span>
          <div>
            <p className="text-sm font-semibold text-panel-700">
              AI connection request
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">
              Allow {consent.clientName} to use Panelavo?
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              Returning to {consent.redirectHost}
            </p>
          </div>
        </div>

        <div className="mt-7 rounded-xl border border-slate-200 bg-slate-50 p-5">
          <div className="flex gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
            <div>
              <p className="font-semibold text-slate-900">
                It will act as {consent.username}
              </p>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                It can use only the supported website actions this account can
                use in Panelavo. If your role or website assignments change, the
                AI connection changes immediately too.
              </p>
            </div>
          </div>
        </div>

        <p className="mt-5 text-sm leading-6 text-slate-600">
          You can disconnect this app at any time from <b>AI access</b>. Only
          approve an app you recognize and trust with the same website access as
          your account.
        </p>

        <form
          action="/api/oauth/authorize"
          method="post"
          className="mt-8 grid gap-3 sm:grid-cols-2"
        >
          <input type="hidden" name="consent_token" value={consent.token} />
          <button
            type="submit"
            name="decision"
            value="deny"
            className="inline-flex h-11 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Do not allow
          </button>
          <button
            type="submit"
            name="decision"
            value="approve"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-panel-600 px-4 text-sm font-semibold text-white transition hover:bg-panel-700"
          >
            Allow connection <ArrowRight className="h-4 w-4" />
          </button>
        </form>
      </div>
    </main>
  );
}
