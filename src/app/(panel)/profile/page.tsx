import type { Metadata } from "next";
import { requireUserOrRedirect } from "@/server/auth/require-user";
import { ProfileForm } from "@/components/users/profile-form";

export const metadata: Metadata = { title: "My profile" };
export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const session = await requireUserOrRedirect();
  return <ProfileForm user={session.user} />;
}
