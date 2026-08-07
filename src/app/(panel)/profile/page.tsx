import type { Metadata } from "next";
import { requireUserOrRedirect } from "@/server/auth/require-user";
import { ProfileForm } from "@/components/users/profile-form";
import { MfaManager } from "@/components/users/mfa-manager";
import { SessionManager } from "@/components/users/session-manager";
import { listUserSessions } from "@/server/auth/session";
import { getSecuritySettings } from "@/server/settings/store";

export const metadata: Metadata = { title: "My profile" };
export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const session = await requireUserOrRedirect({ allowDuringUpdate: true });
  const [sessions, security] = await Promise.all([
    listUserSessions(session.user.username, session.id),
    getSecuritySettings(),
  ]);
  return (
    <div className="mx-auto w-full max-w-3xl space-y-5">
      <ProfileForm
        user={session.user}
        passwordMinLength={security.passwordMinLength}
      />
      <MfaManager enabled={session.user.mfa === true} />
      <SessionManager initialSessions={sessions} />
    </div>
  );
}
