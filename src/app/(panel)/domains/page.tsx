import type { Metadata } from "next";
import { requireUser } from "@/server/auth/require-user";
import { DomainManager } from "@/components/domains/domain-manager";
export const metadata: Metadata = { title: "Domains & DNS" };
export default async function DomainsPage() { await requireUser(); return <DomainManager />; }
