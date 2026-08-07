import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { AppError } from "@/server/cloudpanel/errors";
import { fail, ok } from "@/server/http";
import { assertWriteRequest } from "@/server/security/request";
import { getUptime, saveUptime, uptimeConfigSchema } from "@/server/monitoring/store";

async function authorized(encoded: string, write = false) { const session = await requireUser(); const domain = decodeURIComponent(encoded); await getCloudPanelClient().getSiteSection(session.record.cloudPanel, domain, "settings"); if (write && !(session.user.canCreateSites || session.user.panelRole === "admin")) throw new AppError("FORBIDDEN", "You cannot change this uptime check.", 403); return domain; }
export async function GET(_request: NextRequest, { params }: { params: Promise<{ domain: string }> }) { try { const domain = await authorized((await params).domain); return ok(await getUptime(domain)); } catch (error) { return fail(error); } }
export async function PUT(request: NextRequest, { params }: { params: Promise<{ domain: string }> }) { try { assertWriteRequest(request); const domain = await authorized((await params).domain, true); return ok(await saveUptime(domain, uptimeConfigSchema.parse(await request.json()))); } catch (error) { return fail(error); } }
