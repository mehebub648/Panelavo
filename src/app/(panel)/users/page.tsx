import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUserOrRedirect } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { UserManager } from "@/components/users/user-manager";
export const metadata: Metadata = { title: "Users" };
export default async function UsersPage() { const session = await requireUserOrRedirect({ allowDuringUpdate: true }); if (session.user.panelRole !== "super-admin") redirect("/sites"); const client = getCloudPanelClient(); const [users, sites] = await Promise.all([client.listUsers(session.record.cloudPanel), client.listSites(session.record.cloudPanel)]); return <UserManager initialUsers={users} sites={sites.map((site) => site.domain)} />; }
