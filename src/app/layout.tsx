import type { Metadata } from "next";
import { Toaster } from "sonner";
import { NavigationLoading } from "@/components/layout/navigation-loading";
import "./globals.css";

const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "panelavo";
export const metadata: Metadata = {
  title: { default: appName, template: `%s · ${appName}` },
  description:
    "A self-hosted website management workspace that works over CloudPanel.",
};

import { getBaseDomain } from "@/server/settings/store";
import { getServerPublicIp } from "@/server/network/server-ip";
import { isWildcardConfigured } from "@/server/network/dns";

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const baseDomain = await getBaseDomain();
  const serverIp = await getServerPublicIp();

  let ready = false;
  if (baseDomain) {
    ready = await isWildcardConfigured(serverIp, baseDomain);
  }

  if (!ready) {
    return (
      <html lang="en">
        <body className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
          <div className="w-full max-w-md rounded-2xl border border-amber-200 bg-white p-8 text-center shadow-card">
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-amber-100 text-amber-600">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
            </div>
            <h1 className="text-xl font-bold text-slate-800">DNS Verification Required</h1>
            <p className="mt-3 text-sm text-slate-500">
              {baseDomain 
                ? <>The wildcard DNS record for <strong>*.{serverIp}.{baseDomain}</strong> is not pointing to this server ({serverIp}) yet.</>
                : <>A base domain must be configured on the server to proceed.</>
              }
            </p>
            <p className="mt-3 text-sm text-slate-500">
              The control panel will automatically become available once the DNS propagates.
            </p>
          </div>
        </body>
      </html>
    );
  }

  return (
    <html lang="en">
      <body>
        <NavigationLoading />
        {children}
        <Toaster position="bottom-right" richColors closeButton />
      </body>
    </html>
  );
}
