import type { Metadata } from "next";
import { Toaster } from "sonner";
import { NavigationLoading } from "@/components/layout/navigation-loading";
import "./globals.css";

const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "panelavo";
export const metadata: Metadata = {
  title: { default: appName, template: `%s · ${appName}` },
  description: "A secure frontend for CloudPanel website management.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
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
