import type { Metadata } from "next";
import Link from "next/link";
import { ShieldX } from "lucide-react";
import { CreateSiteForm } from "@/components/sites/create-site-form";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/server/auth/require-user";

export const metadata: Metadata = { title: "Add website" };
export default async function AddSitePage() {
  const session = await requireUser();
  if (!session.user.canCreateSites)
    return (
      <div className="mx-auto grid min-h-[450px] max-w-3xl place-items-center rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-card">
        <div>
          <span className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-amber-50 text-amber-600">
            <ShieldX className="h-7 w-7" />
          </span>
          <h2 className="mt-5 text-xl font-bold">Permission required</h2>
          <p className="mt-2 text-sm text-slate-500">
            Your CloudPanel role does not allow website creation.
          </p>
          <Button asChild variant="outline" className="mt-6">
            <Link href="/sites">Back to websites</Link>
          </Button>
        </div>
      </div>
    );
  return <CreateSiteForm />;
}
