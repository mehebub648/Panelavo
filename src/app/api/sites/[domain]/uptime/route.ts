import type { NextRequest } from "next/server";
import { fail, ok } from "@/server/http";
import { assertWriteRequest } from "@/server/security/request";
import { getUptime, saveUptime, uptimeConfigSchema } from "@/server/monitoring/store";
import { requireAccessibleSite, requireWritableSite } from "@/server/auth/site-access";

async function authorized(encoded: string, write = false) { const domain = decodeURIComponent(encoded); if (write) await requireWritableSite(domain); else await requireAccessibleSite(domain); return domain; }
export async function GET(_request: NextRequest, { params }: { params: Promise<{ domain: string }> }) { try { const domain = await authorized((await params).domain); return ok(await getUptime(domain)); } catch (error) { return fail(error); } }
export async function PUT(request: NextRequest, { params }: { params: Promise<{ domain: string }> }) { try { assertWriteRequest(request); const domain = await authorized((await params).domain, true); return ok(await saveUptime(domain, uptimeConfigSchema.parse(await request.json()))); } catch (error) { return fail(error); } }
