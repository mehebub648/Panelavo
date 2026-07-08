import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { getRecords, mutateRecord } from "@/server/cloudflare/store";
import { assertWriteRequest } from "@/server/security/request";
import { fail, ok } from "@/server/http";
export async function GET(request: NextRequest) { try { const { user } = await requireUser(); const q = request.nextUrl.searchParams; return ok({ records: await getRecords(user.id, q.get("credentialId") ?? "", q.get("zoneId") ?? "") }); } catch (error) { return fail(error); } }
export async function POST(request: NextRequest) { try { assertWriteRequest(request); const { user } = await requireUser(); const body = await request.json(); return ok({ record: await mutateRecord(user.id, String(body.credentialId), String(body.zoneId), body) }); } catch (error) { return fail(error); } }
