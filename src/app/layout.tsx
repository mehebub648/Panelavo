import { Suspense } from "react";
import type { Metadata } from "next";
import { Toaster } from "sonner";
import { NavigationLoading } from "@/components/layout/navigation-loading";
import "./globals.css";

const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "panelavo";
export const metadata: Metadata = {
  title: { default: appName, template: `%s · ${appName}` },
  description: "A secure interface for server and website management.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Suspense fallback={null}>
          <NavigationLoading />
        </Suspense>
        {children}
        <Toaster position="bottom-right" richColors closeButton />
      </body>
    </html>
  );
}
