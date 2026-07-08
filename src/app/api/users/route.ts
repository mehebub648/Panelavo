import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/require-user";
import { getCloudPanelClient } from "@/server/cloudpanel";
import { assertWriteRequest, rateLimit } from "@/server/security/request";
import { fail, ok } from "@/server/http";
export async function GET() { try { const session = await requireUser(); return ok({ users: await getCloudPanelClient().listUsers(session.record.cloudPanel) }); } catch (error) { return fail(error); } }
export async function POST(request: NextRequest) { try { assertWriteRequest(request); const session = await requireUser(); rateLimit(`users:${session.user.id}`, 10, 60_000); await getCloudPanelClient().manageUser(session.record.cloudPanel, await request.json()); return ok({}); } catch (error) { return fail(error); } }
