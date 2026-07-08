import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { checkARecord } from "@/server/cloudflare/store";
import { fail, ok } from "@/server/http";
export async function GET(request: NextRequest) { try { const { user } = await requireUser(); const q = request.nextUrl.searchParams; return ok({ record: await checkARecord(user.id, q.get("credentialId") ?? "", q.get("zoneId") ?? "", q.get("name") ?? "") }); } catch (error) { return fail(error); } }
