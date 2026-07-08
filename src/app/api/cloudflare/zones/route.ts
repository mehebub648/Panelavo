import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { getZones } from "@/server/cloudflare/store";
import { fail, ok } from "@/server/http";
export async function GET(request: NextRequest) { try { const { user } = await requireUser(); return ok(await getZones(user.id, request.nextUrl.searchParams.get("refresh") === "true")); } catch (error) { return fail(error); } }
