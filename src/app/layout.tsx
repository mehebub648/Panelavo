import type { Metadata } from "next";
import { Toaster } from "sonner";
import "./globals.css";

const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "Server Panel";
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
        {children}
        <Toaster position="bottom-right" richColors closeButton />
      </body>
    </html>
  );
}
