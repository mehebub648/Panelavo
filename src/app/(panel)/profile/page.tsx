import type { Metadata } from "next";
import { requireUserOrRedirect } from "@/server/auth/require-user";
import { ProfileForm } from "@/components/users/profile-form";
import { MfaManager } from "@/components/users/mfa-manager";

export const metadata: Metadata = { title: "My profile" };
export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const session = await requireUserOrRedirect({ allowDuringUpdate: true });
  return (
    <div className="mx-auto w-full max-w-3xl space-y-5">
      <ProfileForm user={session.user} />
      <MfaManager enabled={session.user.mfa === true} />
    </div>
  );
}
