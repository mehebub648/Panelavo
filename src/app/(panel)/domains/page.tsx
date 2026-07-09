import type { Metadata } from "next";
import { requireUserOrRedirect } from "@/server/auth/require-user";
import { DomainManager } from "@/components/domains/domain-manager";
export const metadata: Metadata = { title: "Domains & DNS" };
export default async function DomainsPage() { await requireUserOrRedirect(); return <DomainManager />; }
