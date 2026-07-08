import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { addCredential, deleteCredential, listCredentials } from "@/server/cloudflare/store";
import { assertWriteRequest, rateLimit } from "@/server/security/request";
import { fail, ok } from "@/server/http";

export async function GET() { try { const { user } = await requireUser(); return ok({ credentials: await listCredentials(user.id) }); } catch (error) { return fail(error); } }
export async function POST(request: NextRequest) { try { assertWriteRequest(request); const { user } = await requireUser(); rateLimit(`cf-cred:${user.id}`, 5, 60_000); const body = await request.json(); return ok({ credential: await addCredential(user.id, String(body.label ?? "Cloudflare"), String(body.token ?? "")) }, { status: 201 }); } catch (error) { return fail(error); } }
export async function DELETE(request: NextRequest) { try { assertWriteRequest(request); const { user } = await requireUser(); await deleteCredential(user.id, String((await request.json()).id ?? "")); return ok({}); } catch (error) { return fail(error); } }
